// INVARIANT: имя файла миграции, имя класса и поле `name` несут ОДИН timestamp, и он снятый, а не назначенный.
// REGRESSION: две ветки, независимо выбравшие «круглое» число с запасом от соседей, получают одну миграцию.
// Кейсы перенесены из hooks/spec/migration-name-guard.test.sh один в один; сверх корпуса — обходы текстового
// поиска (литерал `name = '...'` внутри SQL) и отсутствие typescript, где bash-версия молча пропускала.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, identifiers, writtenText, NAME, KILL } from '../../src/gates/migration-name.ts';
import { loadTypescript, parseSource } from '../../src/parsers/ts.ts';
import { route } from '../../src/main.ts';
import { GATES } from '../../src/gates/registry.ts';
import { sandbox, payload, HARNESS_ROOT, onlyGate } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';
import type { GateContext, Verdict } from '../../src/types.ts';

const REAL = '1788534985522';
const ROUND = '1786500000000';
const DIR = '/repo/apps/node/svc/migrations';
const ENV = { CLAUDE_HARNESS_TS: TS_PATH, HOME: '/nonexistent-home' };

function ctx(tool: string, field: string, path: string, body: string, env: Record<string, string> = ENV): GateContext {
  const input: Record<string, unknown> = { file_path: path };
  input[field] = body;
  return {
    event: 'pre-write',
    payload: payload('PreToolUse', { tool_name: tool, tool_input: input }) as never,
    env, root: HARNESS_ROOT, stateDir: '/tmp/unused-migration-name', now: Date.now,
  };
}
const verdict = (v: Verdict): string => v.kind;
const reason = (v: Verdict): string => ('reason' in v ? v.reason : '');

describe('migration-name', () => {
  it('has a working typescript for the corpus — without it every content case would be vacuously unknown', () => {
    const loaded = loadTypescript(`${DIR}/x.ts`, ENV);
    assert.ok(loaded.ts, `typescript не загружен (${'missing_reason' in loaded ? loaded.missing_reason : ''}) — задать CLAUDE_HARNESS_TS`);
  });

  describe('останавливает', () => {
    it('denies a hand-picked timestamp: five trailing zeros are chosen with a margin from neighbours, not taken', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${ROUND}-add-column.ts`, `export class AddColumn${ROUND} implements MigrationInterface {}`));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /придуман/);
    });

    it('denies a class carrying a different timestamp than the file name', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, 'export class AddColumn1700000000001 implements MigrationInterface {}'));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /класс/);
    });

    it('denies a `name` field that drifted from the file name — it is the row in the migrations table', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, "name = 'AddColumn1700000000001';"));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /поле name/);
    });

    it('denies a file name outside <timestamp13>-<kebab>.ts — TypeORM orders migrations by that number', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/add-column.ts`, 'x'));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /не в форме/);
    });

    it('denies a class whose stem does not match the file name even when the timestamp agrees', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, `export class SomethingElse${REAL} implements MigrationInterface {}`));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /ожидается «AddColumn/);
    });
  });

  describe('пропускает', () => {
    it('stays silent on a taken timestamp with class and name agreeing', () => {
      const body = `export class AddColumn${REAL} implements MigrationInterface {\n  name = 'AddColumn${REAL}';\n}`;
      assert.equal(verdict(decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, body))), 'silent');
    });

    it('stays silent outside a migrations directory — a service class named anything is not this gate business', () => {
      assert.equal(verdict(decide(ctx('Write', 'content', '/repo/src/service.ts', 'export class Foo {}'))), 'silent');
    });

    it('stays silent on an edit of the migration body that declares no class and no name', () => {
      const v = decide(ctx('Edit', 'new_string', `${DIR}/${REAL}-add-column.ts`, "await queryRunner.query('ALTER TABLE x ADD y int');"));
      assert.equal(verdict(v), 'silent');
    });

    it('stays silent for a tool that writes nothing — Bash carrying a migration path is not a write', () => {
      assert.equal(verdict(decide(ctx('Bash', 'content', `${DIR}/${ROUND}-x.ts`, 'ls'))), 'silent');
    });

    it('does not read `name` out of a SQL string literal — the text search did, and denied a correct migration', () => {
      const body = `export class AddColumn${REAL} implements MigrationInterface {\n`
        + `  public async up(q: QueryRunner): Promise<void> {\n`
        + `    await q.query("ALTER TABLE t ADD CONSTRAINT c CHECK (name = 'AddColumn1700000000001')");\n`
        + '  }\n}';
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, body));
      assert.equal(verdict(v), 'silent', reason(v));
    });
  });

  describe('нет данных — не тишина', () => {
    it('answers unknown when typescript is nowhere near the file: the file name is proven, the class is not', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${REAL}-add-column.ts`, `export class Whatever${REAL} implements MigrationInterface {}`, { HOME: '/nonexistent-home' }));
      assert.equal(verdict(v), 'unknown');
      assert.match(reason(v), /не проверены/);
    });

    it('still denies the file-name half when typescript is missing — half a contract proven is still a violation', () => {
      const v = decide(ctx('Write', 'content', `${DIR}/${ROUND}-add-column.ts`, 'x', { HOME: '/nonexistent-home' }));
      assert.equal(verdict(v), 'deny');
      assert.match(reason(v), /придуман/);
    });

    it('answers unknown for a Write without content — what lands in the file is not knowable', () => {
      const p = payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${DIR}/${REAL}-a.ts` } });
      const v = decide({ event: 'pre-write', payload: p as never, env: ENV, root: HARNESS_ROOT, stateDir: '/tmp/unused', now: Date.now });
      assert.equal(verdict(v), 'unknown');
    });

    it('reports the projected text per tool: Write takes content, Edit takes new_string, MultiEdit joins the edits', () => {
      const w = writtenText({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'a' } } as never);
      const e = writtenText({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { new_string: 'b' } } as never);
      const m = writtenText({ hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { edits: [{ new_string: 'c' }, { new_string: 'd' }] } } as never);
      assert.deepEqual([w, e, m].map((x) => (x.kind === 'text' ? x.text : x.kind)), ['a', 'b', 'c\nd']);
    });
  });

  describe('разбор', () => {
    it('takes the class name and the `name` value from the AST in both forms — class field and bare assignment', () => {
      const loaded = loadTypescript(`${DIR}/x.ts`, ENV);
      assert.ok(loaded.ts);
      const parse = (text: string) => identifiers(loaded.ts!, parseSource(loaded.ts!, text, 'm.ts').sf);
      assert.deepEqual(parse(`export class A${REAL} implements MigrationInterface {\n  name = 'A${REAL}';\n}`), { cls: `A${REAL}`, name: `A${REAL}` });
      assert.deepEqual(parse(`name = 'A${REAL}';`), { cls: null, name: `A${REAL}` });
      assert.deepEqual(parse('const q = "name = \'A1\'";'), { cls: null, name: null });
    });
  });

  describe('роутер', () => {
    it('is registered on pre-write with its own kill-switch', () => {
      const gate = GATES.find((g) => g.name === NAME);
      assert.ok(gate, 'гейт не зарегистрирован — роутер его не вызовет');
      assert.deepEqual(gate.events, ['pre-write']);
      assert.equal(gate.killSwitch, KILL);
    });

    it(`writes nothing and stays silent under ${KILL}=1, and denies the same payload without it`, async () => {
      const sb = sandbox('harness-migration-kill-');
      const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_HARNESS_TS: TS_PATH, ...onlyGate(NAME) };
      const p = payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${DIR}/${ROUND}-x.ts`, content: 'y' } });
      assert.equal((await route('pre-write', p as never, { ...base, [KILL]: '1' })).kind, 'silent');
      assert.equal((await route('pre-write', p as never, base)).kind, 'deny');
      sb.cleanup();
    });
  });
});
