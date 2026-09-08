// INVARIANT К1: барьер к базе видит SET/ALTER ROLE/DO как узлы, а комментарий и строковый литерал — нет.
// Молча ломалось: hooks/pg-session-state-guard.sh:63-83 — grep по тексту; INC-PG-READONLY-BYPASS обошёл его текстом запроса.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSql, stmtKind, stmtNode, walk } from '../../src/parsers/sql.ts';

describe('parseSql', () => {
  it('distinguishes SET from SET LOCAL and reads the GUC name from the node, case- and syntax-insensitively', async () => {
    const a = await parseSql('sEt default_transaction_read_only TO off');
    const b = await parseSql('SET LOCAL default_transaction_read_only = off');
    assert.equal(stmtKind(a.stmts[0]), 'VariableSetStmt');
    assert.equal(stmtNode<{ name: string; is_local?: boolean }>(a.stmts[0]).name, 'default_transaction_read_only');
    assert.equal(Boolean(stmtNode<{ is_local?: boolean }>(a.stmts[0]).is_local), false);
    assert.equal(stmtNode<{ is_local?: boolean }>(b.stmts[0]).is_local, true);
  });
  it('does not see a SET hidden in a comment or a string literal — those are not statements', async () => {
    for (const sql of ['/* SET default_transaction_read_only = off */ SELECT 1', "SELECT 'SET default_transaction_read_only = off'", "-- нельзя\nSELECT 1"]) {
      const p = await parseSql(sql);
      assert.deepEqual(p.stmts.map(stmtKind), ['SelectStmt'], sql);
    }
  });
  it('parses ALTER ROLE … SET, ADD CONSTRAINT … NOT VALID, VALIDATE CONSTRAINT and a partial unique index — the forms the old regex could not', async () => {
    assert.equal(stmtKind((await parseSql("ALTER ROLE app SET statement_timeout = '0'")).stmts[0]), 'AlterRoleSetStmt');
    const ck = await parseSql('ALTER TABLE "orders_lines" ADD CONSTRAINT ck CHECK (a > 0) NOT VALID');
    const cmd = stmtNode<{ cmds: Array<{ AlterTableCmd: { subtype: string; def?: { Constraint?: { contype: string; skip_validation?: boolean } } } }> }>(ck.stmts[0]).cmds[0].AlterTableCmd;
    assert.equal(cmd.subtype, 'AT_AddConstraint');
    assert.equal(cmd.def?.Constraint?.contype, 'CONSTR_CHECK');
    assert.equal(cmd.def?.Constraint?.skip_validation, true);
    assert.equal(stmtNode<{ cmds: Array<{ AlterTableCmd: { subtype: string } }> }>((await parseSql('ALTER TABLE t VALIDATE CONSTRAINT ck')).stmts[0]).cmds[0].AlterTableCmd.subtype, 'AT_ValidateConstraint');
    const idx = stmtNode<{ unique?: boolean; whereClause?: unknown }>((await parseSql('CREATE UNIQUE INDEX CONCURRENTLY i ON units (serial_id) WHERE quantity > 0')).stmts[0]);
    assert.equal(idx.unique, true); assert.ok(idx.whereClause);
  });
  it('keeps a DO $$…$$ body opaque as DoStmt and exposes set_config as a FuncCall node reachable by walk()', async () => {
    assert.equal(stmtKind((await parseSql("DO $$ BEGIN EXECUTE 'SET default_transaction_read_only = off'; END $$")).stmts[0]), 'DoStmt');
    const p = await parseSql("SELECT set_config('statement_timeout', '0', false)");
    const funcs = [...walk(p.stmts)].filter((n) => 'FuncCall' in n).map((n) => (n.FuncCall as { funcname: Array<{ String: { sval: string } }> }).funcname.map((x) => x.String.sval).join('.'));
    assert.deepEqual(funcs, ['set_config']);
  });
  it('returns an error value, not an exception, for unparsable text', async () => {
    const p = await parseSql('SELEC 1 FROMM');
    assert.equal(p.stmts.length, 0); assert.match(p.error ?? '', /syntax/i);
  });
  it('parses a multi-statement batch in order', async () => {
    assert.deepEqual((await parseSql('BEGIN; SET default_transaction_read_only = off; DELETE FROM jobs; COMMIT')).stmts.map(stmtKind), ['TransactionStmt', 'VariableSetStmt', 'DeleteStmt', 'TransactionStmt']);
  });
});
