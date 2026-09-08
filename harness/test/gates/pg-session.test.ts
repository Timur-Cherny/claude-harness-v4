// INVARIANT К1 (INC-PG-READONLY-BYPASS): барьер к Postgres, держащийся состоянием соединения, виден как
// узел AST — SET без LOCAL, ALTER ROLE/DATABASE … SET, set_config(…, false), DO, options=-c — а комментарий
// и строковый литерал узлом не являются. Молча ломалось: hooks/pg-session-state-guard.sh:63-83 grep по
// тексту требовал `=`: `SET … TO off`, set_config, DO $$…$$, URL ?options=-c и `psql -f` проходили (exit 0),
// а `/* SET … */ SELECT 1` ложно блокировался (exit 2) — проверено пробой 05.09.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, judgeSql, psqlSources, conninfoValue, exemptPath, NAME, KILL } from '../../src/gates/pg-session.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-pg-');
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };

function ctx(event: HarnessEvent, p: Record<string, unknown>): GateContext {
  return { event, payload: p as unknown as HookPayload, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
}
const bash = (command: string) => decide(ctx('pre-bash', bashPayload(command, { cwd: sb.dir })));
const psql = (sql: string) => bash(`psql -c "${sql}"`);
const write = (file_path: string, content: string) => decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path, content }, tool_use_id: 'toolu_w' })));
const edit = (file_path: string, new_string: string) => decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Edit', tool_input: { file_path, old_string: 'x', new_string }, tool_use_id: 'toolu_e' })));

async function deny(v: Promise<Verdict>, re: RegExp): Promise<void> {
  const r = await v; assert.equal(r.kind, 'deny', JSON.stringify(r)); assert.match((r as { reason: string }).reason, re);
}
async function unknown(v: Promise<Verdict>, re: RegExp): Promise<void> {
  const r = await v; assert.equal(r.kind, 'unknown', JSON.stringify(r)); assert.match((r as { reason: string }).reason, re);
}
async function silent(v: Promise<Verdict>): Promise<void> { assert.deepEqual(await v, { kind: 'silent' }); }

const ALTER_ROLE = "ALTER ROLE grafana_ro SET default_transaction_read_only = on";
const ALTER_APP = "ALTER ROLE app SET statement_timeout = '30s'";

describe('pg-session pre-bash — bash corpus (pg-session-state-guard.test.sh)', () => {
  it('denies a session SET default_transaction_read_only', () => deny(psql('SET default_transaction_read_only = on'), /сессионный SET default_transaction_read_only без LOCAL/));
  it('denies a session SET statement_timeout', () => deny(psql("SET statement_timeout = '15s'"), /сессионный SET statement_timeout/));
  it('denies ALTER ROLE … SET default_transaction_read_only — the case that slipped past the note', () => deny(psql(ALTER_ROLE), /ALTER ROLE … SET default_transaction_read_only.*pg_db_role_setting/));
  it('denies ALTER ROLE … SET statement_timeout', () => deny(psql(ALTER_APP), /ALTER ROLE … SET statement_timeout/));
  it('denies ALTER DATABASE … SET', () => deny(psql("ALTER DATABASE wms SET statement_timeout = '30s'"), /ALTER DATABASE … SET statement_timeout/));
  it('passes GRANT SELECT — the barrier held by privileges', () => silent(psql('GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_ro')));
  it('passes CREATE ROLE without SET', () => silent(psql("CREATE ROLE grafana_ro WITH LOGIN PASSWORD 'x'")));
  it('passes BEGIN TRANSACTION READ ONLY + SET LOCAL — dies on ROLLBACK', () => silent(psql("BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15s'; SELECT 1;")));
  it('passes ALTER ROLE … RESET — removing the setting is not a violation', () => silent(psql('ALTER ROLE grafana_ro RESET default_transaction_read_only')));
  it('passes a command that writes a file instead of talking to the database', () => silent(bash("cat > /tmp/x.sql <<EOF\nALTER ROLE app SET statement_timeout = '30s';\nEOF")));
  it('passes a plain SELECT', () => silent(psql('SELECT count(*) FROM orders')));
  it('ignores other tools on pre-bash', () => silent(decide(ctx('pre-bash', payload('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })))));
});

describe('pg-session pre-write — bash corpus', () => {
  it('denies ALTER ROLE … SET inside a written manifest', () => deny(write('/tmp/x.yaml', `command:\n  - sh\n  - -c\n  - ${ALTER_ROLE};`), /ALTER ROLE … SET/));
  it('denies startup parameter options=-c in an Edit', () => deny(edit('/tmp/x.sql', "extra: { options: '-c statement_timeout=30s' }"), /options=-c/));
  it('passes a comment that forbids the construct — text is not a statement', () => silent(write('/tmp/x.yaml', '# Никаких ALTER ROLE ... SET: сессионный GUC уезжает за пулер')));
  it('passes a description of the construct in .md — documentation does not execute', () => silent(write('/tmp/note.md', 'нота: писать роль-левел GUC нельзя')));
  it('passes the spec of the gate itself, which must contain the violation', () => {
    assert.ok(exemptPath(join(HARNESS_ROOT, '..', 'hooks', 'spec', 'x.test.sh')));
    return silent(write(join(HARNESS_ROOT, '..', 'hooks', 'spec', 'x.test.sh'), ALTER_APP));
  });
});

describe('pg-session kill-switch and routing', () => {
  it(`${KILL}=1 through route(): silent and nothing written to state; without it the same payload is denied by ${NAME}`, async () => {
    const p = bashPayload(`psql -c "${ALTER_APP}"`, { cwd: sb.dir }) as unknown as HookPayload;
    assert.deepEqual(await route('pre-bash', p, { ...env, [KILL]: '1' }), { kind: 'silent' });
    assert.deepEqual(readdirSync(sb.stateDir), []);
    const live = await route('pre-bash', p, env);
    assert.equal(live.kind, 'deny'); assert.equal((live as { gate: string }).gate, NAME);
  });
  it('lifts unknown to ask on pre-bash through route() — a parse failure is never a pass', async () => {
    const v = await route('pre-bash', bashPayload('psql -c "SELEC 1 FROMM"', { cwd: sb.dir }) as unknown as HookPayload, env);
    assert.equal(v.kind, 'ask'); assert.match((v as { reason: string }).reason, /не разобран/);
  });
});

describe('pg-session — K1 bypasses of the text grep, now seen as AST nodes (new)', () => {
  it('REGRESSION INC-PG-READONLY-BYPASS: SET … TO off without `=` is denied', () => deny(psql('SET default_transaction_read_only TO off'), /сессионный SET default_transaction_read_only/));
  it('denies SET SESSION in any letter case', () => deny(psql("sEt SESSION statement_timeout TO '1s'"), /statement_timeout/));
  it('denies SET without LOCAL even inside BEGIN … COMMIT — the setting outlives the transaction', () => deny(psql('BEGIN; SET default_transaction_read_only = on; COMMIT'), /без LOCAL/));
  it('passes SET … TO DEFAULT and RESET — both remove the setting', async () => {
    await silent(psql('SET statement_timeout TO DEFAULT'));
    await silent(psql('RESET statement_timeout'));
    await silent(psql('ALTER DATABASE wms RESET ALL'));
  });
  it('denies set_config(guc, …, false) and a non-literal is_local; passes is_local=true and a foreign GUC; unknown for a non-literal GUC name', async () => {
    await deny(psql("SELECT set_config('default_transaction_read_only', 'off', false)"), /set_config\('default_transaction_read_only'.*is_local=false/);
    await deny(psql("SELECT set_config('statement_timeout', '0', $1)"), /is_local не литерал/);
    await deny(psql("INSERT INTO t SELECT set_config('lock_timeout', '0', false)"), /lock_timeout/);
    await silent(psql("SELECT set_config('statement_timeout', '0', true)"));
    await silent(psql("SELECT set_config('search_path', 'public', false)"));
    await unknown(psql("SELECT set_config(current_setting('x'), '0', false)"), /нелитеральным именем GUC/);
  });
  it('denies a DO block — its body is opaque to the parser', () => deny(psql("DO $$ BEGIN EXECUTE 'SET default_transaction_read_only TO off'; END $$"), /DO-блок: тело непрозрачно/));
  it('denies EXECUTE of a prepared statement outside the visible batch, judges a visible PREPARE by its body', async () => {
    await deny(psql('EXECUTE q'), /EXECUTE q: тело подготовленного запроса непрозрачно/);
    await deny(psql("PREPARE p AS SELECT set_config('statement_timeout', '0', false); EXECUTE p"), /set_config/);
    await silent(psql('PREPARE p AS SELECT 1; EXECUTE p'));
  });
  it('passes SET hidden in a comment or a string literal — the grep false positive is gone', async () => {
    await silent(psql('/* SET default_transaction_read_only = off */ SELECT 1'));
    await silent(psql("SELECT 'SET default_transaction_read_only = off'"));
    await silent(psql("-- SET default_transaction_read_only = off\nSELECT 1"));
  });
  it('passes function-level SET (CREATE FUNCTION … SET) — it reverts on return, not a session setting', () => silent(psql("CREATE FUNCTION f() RETURNS int LANGUAGE sql SET statement_timeout = '1s' AS 'select 1'")));
  it('answers unknown for unparsable SQL', () => unknown(psql('SELEC 1 FROMM'), /SQL не разобран/));
});

describe('pg-session — where the SQL comes from (new)', () => {
  it('denies options=-c in a postgres:// URL (searchParams, not text) and passes a URL without it', async () => {
    await deny(bash('psql "postgres://u@h/db?options=-c%20statement_timeout%3D30s"'), /options=-c в строке подключения/);
    await deny(bash('DATABASE_URL="postgresql://u:p@h:5432/db?sslmode=require&options=-c%20statement_timeout%3D30s" npm start'), /options=-c/);
    await silent(bash('psql "postgres://u@h/db?sslmode=require"'));
    await unknown(bash('psql "postgres://[bad"'), /не разобрана как URL/);
  });
  it('denies PGOPTIONS=-c as an env prefix and options=-c in a libpq conninfo string', async () => {
    await deny(bash("PGOPTIONS='-c statement_timeout=30s' psql -c 'select 1'"), /PGOPTIONS=-c/);
    await deny(bash("psql \"host=h dbname=d options='-c statement_timeout=30s'\""), /options='-c/);
    assert.equal(conninfoValue("host=h options='-c a=b' user=u", 'options'), '-c a=b');
    assert.equal(conninfoValue('host=h', 'options'), null);
  });
  it('reads the file behind psql -f / --file= / < redirect, denies its ALTER ROLE and answers unknown for a missing file', async () => {
    const f = join(sb.dir, 'x.sql'); writeFileSync(f, `${ALTER_APP};\n`);
    await deny(bash(`psql -f ${f}`), /ALTER ROLE/);
    await deny(bash(`psql --file=${f} wms`), /ALTER ROLE/);
    await deny(bash('psql -d wms < x.sql'), /ALTER ROLE/);
    await deny(bash('psql wms <x.sql'), /ALTER ROLE/);
    await unknown(bash('psql -f missing.sql'), /файл SQL не прочитан: missing\.sql/);
    assert.deepEqual(psqlSources(['-qAt', '-f', 'a.sql', '--command=SELECT 1', '-cSELECT 2', '-f', '-']), [
      { kind: 'file', path: 'a.sql' }, { kind: 'inline', sql: 'SELECT 1' }, { kind: 'inline', sql: 'SELECT 2' }, { kind: 'stdin' },
    ]);
  });
  it('answers unknown when the body is not visible: $(…), pipe into psql, -f - without a here-doc', async () => {
    await unknown(bash('$(cat x.sql) | psql'), /подстановка/);
    await unknown(bash('cat x.sql | psql wms'), /stdin из другой команды/);
    await unknown(bash('psql -f - wms'), /читает stdin/);
  });
  it('judges the SQL a here-doc carries — the form the barrier was silently blind to', async () => {
    await deny(bash("psql -h db <<'SQL'\nSET statement_timeout = 0;\nSELECT 1;\nSQL"), /statement_timeout/);
    await deny(bash("psql -f - <<'SQL'\n" + ALTER_APP + ';\nSQL'), /ALTER ROLE/);
    await silent(bash("psql -h db <<'SQL'\nSELECT count(*) FROM orders;\nSQL"));
    await silent(bash("psql wms <<'SQL'\nBEGIN; SET LOCAL statement_timeout = '5s'; SELECT 1; COMMIT;\nSQL"));
  });
  it('keeps unknown where the here-doc body is still not knowable: substitution, no terminator', async () => {
    await unknown(bash('psql <<SQL\nSET statement_timeout = $T;\nSQL'), /подстановка|here-doc-expansion/);
    await unknown(bash('psql <<SQL\nSELECT 1;'), /ограничител|unterminated/);
  });
  it('finds psql inside a script fed to bash by here-doc — one level of nesting, same as sh -c', async () => {
    await deny(bash("bash <<'SH'\npsql -c \"" + ALTER_APP + '"\nSH'), /ALTER ROLE/);
  });
  it('passes psql/pg_dump invocations that carry no statements at all', async () => {
    await silent(bash('psql -l'));
    await silent(bash('pg_dump wms > out.sql'));
    await silent(bash('PGPASSWORD=x pg_restore -d wms dump.bin'));
  });
  it('finds psql behind kubectl exec pod -- and inside a one-level sh -c; PGPASSWORD alone is not a violation', async () => {
    await deny(bash(`kubectl exec pod-x -n wms -- psql -U app -c "${ALTER_APP}"`), /ALTER ROLE/);
    await deny(bash(`bash -c "psql -c \\"${ALTER_APP}\\""`), /ALTER ROLE/);
    await silent(bash("kubectl exec pod-x -- env PGPASSWORD=x psql -c 'select 1'"));
  });
  it('reads -c from a short cluster (-qAtc) and from --command', async () => {
    await deny(bash("psql -qAtc \"SET statement_timeout = '1s'\""), /statement_timeout/);
    await deny(bash("psql --command \"SET lock_timeout = '1s'\" wms"), /lock_timeout/);
    await deny(bash('psql -v ON_ERROR_STOP=1 -c "SET idle_in_transaction_session_timeout = 0"'), /idle_in_transaction_session_timeout/);
  });
});

describe('pg-session pre-write — SQL inside written files (new)', () => {
  it('scans a host document from the earliest statement keyword: UPDATE … SET statement_timeout is an UPDATE, not a SET', () => silent(write('/tmp/repo/src/a.ts', "await q(\"UPDATE settings SET statement_timeout = '1'\");")));
  it('ignores JS `new Set([...])` and `do {` — unparsable candidates give no verdict', () => silent(write('/tmp/repo/src/b.ts', "const GUCS = new Set(['statement_timeout']);\ndo { i++; } while (i < 3);\nconst reset = settings.get('statement_timeout');")));
  it('passes a .sql migration with constraints and indexes, and SET LOCAL', async () => {
    await silent(write('/tmp/repo/migrations/1.sql', 'ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0) NOT VALID;\nCREATE UNIQUE INDEX CONCURRENTLY i ON t (a);\n'));
    await silent(write('/tmp/repo/migrations/2.sql', "BEGIN;\nSET LOCAL statement_timeout = '1s';\nUPDATE t SET a = 1;\nCOMMIT;\n"));
  });
  it('denies a multi-line DO $$ … $$ block in a .sql file and an ALTER ROLE … SET in an Edit', async () => {
    await deny(write('/tmp/repo/migrations/3.sql', "DO $$\nBEGIN\n  EXECUTE 'SET default_transaction_read_only TO off';\nEND\n$$;\n"), /DO-блок/);
    await deny(edit('/tmp/repo/migrations/4.sql', `${ALTER_APP};`), /ALTER ROLE/);
  });
  it('denies a DO $$ … $$ block embedded in a TypeORM migration string', () => deny(write('/tmp/repo/src/migrations/X.ts', "await queryRunner.query(`DO $x$\nBEGIN\n  PERFORM 1;\nEND\n$x$`);"), /DO-блок/));
  it('answers unknown for a .sql file that does not parse at all — cannot prove safety', () => unknown(write('/tmp/repo/seed.sql', '\\connect wms\nSELEC 1;\n'), /SQL-файл не разобран/));
  it('denies set_config(…, false) inside a JS query string and a bare PERFORM set_config(…) fragment', async () => {
    await deny(write('/tmp/repo/src/c.ts', "client.query(\"SELECT set_config('statement_timeout', '0', false)\")"), /set_config/);
    await deny(write('/tmp/repo/src/d.ts', "  PERFORM set_config('statement_timeout', '0', false);"), /set_config/);
    await silent(write('/tmp/repo/src/e.ts', "  PERFORM set_config('statement_timeout', '0', true);"));
  });
  it('denies options=-c in JSON/YAML config and in a .env URL; passes an unrelated options key', async () => {
    await deny(write('/tmp/repo/ds.json', '{"jsonData":{"extra":{"options":"-c statement_timeout=30s"}}}'), /options=-c/);
    await deny(write('/tmp/repo/deploy.yaml', 'env:\n  PGOPTIONS: "-c statement_timeout=30s"\n'), /options=-c/);
    await deny(write('/tmp/repo/.env', 'DATABASE_URL=postgres://u@h/db?options=-c%20statement_timeout%3D30s\n'), /options=-c/);
    await silent(write('/tmp/repo/cfg.json', '{"options":"verbose","extra":{"options":"--verbose"}}'));
  });
  it('exempts test files by name and passes an empty write; NotebookEdit is judged by new_source', async () => {
    await silent(write('/tmp/repo/test/gates/x.test.ts', `${ALTER_APP}`));
    await silent(write('/tmp/repo/a.sql', ''));
    await deny(decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/repo/n.ipynb', new_source: "SET statement_timeout = '1s'" } }))), /statement_timeout/);
  });
  it('judgeSql is the shared core: multi-statement batches are judged in order and deny wins over unknown', async () => {
    assert.equal((await judgeSql("SELECT 1; SET LOCAL statement_timeout = '1s'")).kind, 'clean');
    assert.equal((await judgeSql("SELECT set_config(current_setting('x'), '0', false); SET statement_timeout = '1s'")).kind, 'deny');
  });
});
