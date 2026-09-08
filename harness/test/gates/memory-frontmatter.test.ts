// INVARIANT: нота памяти под */.claude/projects/*/memory/*.md ложится на диск только с шапкой, где
// name = имя файла, description непустой, metadata.type из четырёх типов и тело непустое.
// REGRESSION: hooks/memory-integrity.sh проверял файл ПОСЛЕ записи (PostToolUse) — сломанная шапка
// успевала лечь на диск и попадала в индекс; здесь проверяется содержимое, которое будет записано.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, checkNote, noteSlug, NAME, KILL } from '../../src/gates/memory-frontmatter.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-memfm-');
after(() => sb.cleanup());
const MEM = join(sb.dir, '.claude', 'projects', 'proj', 'memory');
mkdirSync(MEM, { recursive: true });
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };

function ctx(event: HarnessEvent, p: Record<string, unknown>): GateContext {
  return { event, payload: p as unknown as HookPayload, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
}
const writeP = (file_path: string, content?: string) => payload('PreToolUse', { tool_name: 'Write', tool_input: content === undefined ? { file_path } : { file_path, content }, tool_use_id: 'toolu_w' });
const editP = (file_path: string, old_string: string, new_string: string, replace_all = false) => payload('PreToolUse', { tool_name: 'Edit', tool_input: { file_path, old_string, new_string, replace_all }, tool_use_id: 'toolu_e' });
const write = (name: string, content?: string) => decide(ctx('pre-write', writeP(join(MEM, name), content)));

const GOOD = '---\nname: good-note\ndescription: корректная нота, на которую есть строка в индексе\nmetadata:\n  type: project\n---\nтело ноты\n';
const note = (name: string, type = 'project', description = 'проба') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\nтело\n`;

function denyReason(v: Verdict): string { assert.equal(v.kind, 'deny', JSON.stringify(v)); return (v as { reason: string }).reason; }

describe('memory-frontmatter — bash corpus (deny-gates.test.sh, секция memory-integrity)', () => {
  it('denies a note without frontmatter', () => {
    assert.match(denyReason(write('broken.md', 'текст без шапки')), /нет frontmatter/);
  });
  it('denies metadata.type outside {user, feedback, project, reference}', () => {
    assert.match(denyReason(write('bad-type.md', note('bad-type', 'nonexistent'))), /type 'nonexistent' не из набора/);
  });
  it('denies name that differs from the file slug — [[slug]] links would not resolve', () => {
    assert.match(denyReason(write('mismatch.md', note('other-name'))), /name 'other-name' не совпадает с именем файла 'mismatch'/);
  });
  it('denies an empty description', () => {
    assert.match(denyReason(write('no-desc.md', '---\nname: no-desc\ndescription:\nmetadata:\n  type: project\n---\nтело\n')), /пустой description/);
  });
  it('stays silent for a correct note', () => {
    assert.deepEqual(write('good-note.md', GOOD), { kind: 'silent' });
  });
  it('stays silent for MEMORY.md itself — the index has no frontmatter by design', () => {
    assert.deepEqual(write('MEMORY.md', '- [Проба](good-note.md) — строка индекса\n'), { kind: 'silent' });
  });
  it('stays silent for a file outside a memory directory even without frontmatter', () => {
    assert.deepEqual(decide(ctx('pre-write', writeP(join(sb.dir, 'outside.md'), 'текст без шапки'))), { kind: 'silent' });
    assert.equal(noteSlug(join(sb.dir, 'outside.md')), null);
    assert.equal(noteSlug(join(MEM, 'x.md')), 'x');
  });
  it(`kill-switch ${KILL}=1 through route(): silent and nothing written to state`, async () => {
    const p = writeP(join(MEM, 'broken2.md'), 'текст без шапки') as unknown as HookPayload;
    assert.deepEqual(await route('pre-write', p, { ...env, [KILL]: '1' }), { kind: 'silent' });
    assert.deepEqual(readdirSync(sb.stateDir), []);
    const live = await route('pre-write', p, env);
    assert.equal(live.kind, 'deny'); assert.equal((live as { gate: string }).gate, NAME);
  });
});

describe('memory-frontmatter — pre-write projection and strict mini-parser (new)', () => {
  it('applies an Edit to the current file and denies when the edit breaks the name', () => {
    const f = join(MEM, 'good-note.md'); writeFileSync(f, GOOD);
    assert.match(denyReason(decide(ctx('pre-write', editP(f, 'name: good-note', 'name: renamed')))), /name 'renamed' не совпадает/);
    assert.deepEqual(decide(ctx('pre-write', editP(f, 'тело ноты', 'тело ноты, дополненное'))), { kind: 'silent' });
  });
  it('applies replace_all when asked — every occurrence changes, as the tool would do', () => {
    const f = join(MEM, 'good-note.md'); writeFileSync(f, GOOD.replace('тело ноты', 'good-note и ещё good-note'));
    const v = decide(ctx('pre-write', editP(f, 'good-note', 'other', true)));
    assert.match(denyReason(v), /name 'other'/);
  });
  it('answers unknown, not silent, when the Edit target cannot be read or old_string is absent', () => {
    const missing = decide(ctx('pre-write', editP(join(MEM, 'nope.md'), 'a', 'b')));
    assert.equal(missing.kind, 'unknown'); assert.match((missing as { reason: string }).reason, /не прочитан/);
    const f = join(MEM, 'good-note.md'); writeFileSync(f, GOOD);
    const absent = decide(ctx('pre-write', editP(f, 'нет такой строки', 'b')));
    assert.equal(absent.kind, 'unknown'); assert.match((absent as { reason: string }).reason, /old_string не найден/);
    assert.equal(write('no-content.md').kind, 'unknown');
  });
  it('denies a frontmatter that is never closed and a note with an empty body — by different reasons', () => {
    assert.match(denyReason(write('open.md', '---\nname: open\ndescription: x\nmetadata:\n  type: project\nтело\n')), /не закрыт/);
    assert.match(denyReason(write('hollow.md', '---\nname: hollow\ndescription: x\nmetadata:\n  type: project\n---\n\n  \n')), /пустое тело/);
  });
  it('requires type under metadata — a top-level type: is not metadata.type', () => {
    assert.match(denyReason(write('flat.md', '---\nname: flat\ndescription: x\ntype: project\n---\nтело\n')), /нет metadata\.type/);
  });
  it('accepts a quoted description and a folded block scalar (>-) with indented lines', () => {
    assert.deepEqual(write('quoted.md', '---\nname: quoted\ndescription: "в кавычках"\nmetadata:\n  type: reference\n---\nтело\n'), { kind: 'silent' });
    assert.deepEqual(write('folded.md', '---\nname: folded\ndescription: >-\n  первая строка\n  вторая строка\nmetadata:\n  type: user\n---\nтело\n'), { kind: 'silent' });
    assert.match(denyReason(write('empty-fold.md', '---\nname: empty-fold\ndescription: >-\nmetadata:\n  type: user\n---\nтело\n')), /пустой description/);
  });
  it('reports every problem of a note in one verdict, joined by «; »', () => {
    const problems = checkNote('---\nname: wrong\ndescription:\nmetadata:\n  type: nope\n---\n', 'multi');
    assert.equal(problems.length, 4, problems.join(' | '));
    assert.match(denyReason(write('multi.md', '---\nname: wrong\ndescription:\nmetadata:\n  type: nope\n---\n')), /не совпадает.*; .*пустой description.*; .*не из набора.*; .*пустое тело/);
  });
  it('ignores NotebookEdit and non-pre-write events — the gate is about .md notes on pre-write only', () => {
    assert.deepEqual(decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(MEM, 'x.ipynb'), new_source: 'x' } }))), { kind: 'silent' });
    assert.deepEqual(decide(ctx('post', payload('PostToolUse', { tool_name: 'Write', tool_input: { file_path: join(MEM, 'broken.md'), content: 'x' } }))), { kind: 'silent' });
  });
});
