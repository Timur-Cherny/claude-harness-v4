// Молча ломалось: `readme-inventory --check || exit 1` глушил остальную часть session-start (класс К2);
// расписание без отметки о прогоне выглядело как «ok». INVARIANT: числа в README — из файлов, дрейф
// назван; отсутствие отметки/источника сигнала = unknown, не ok; обе стороны каждого порога; гейт только
// читает — состояние расписания и README не меняются.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, inventoryData, readmeDrift, scheduleReport, KILL, NAME } from '../../src/session/session-start.ts';
import { localDate } from '../../src/session/common.ts';
import { route } from '../../src/main.ts';
import type { GateContext } from '../../src/types.ts';

const NOW = 1_800_000_000_000;
const today = localDate(NOW);
const ago = (d: number) => localDate(NOW - d * 86_400_000);
type Sb = ReturnType<typeof sandbox>;

const SPEC = { rules: [
  { id: 'memory-review', command: '/memory-review', signal: 'memory_notes', trigger: { delta: 25 }, min_interval_days: 5, max_interval_days: 21 },
  { id: 'friction-review', command: '/friction-review', signal: 'friction_events', trigger: { delta: 20 }, min_interval_days: 3, max_interval_days: 14 },
] };

/** Репозиторий-фикстура в форме контура: hooks/settings/agents/skills/memory/epics + README с маркерами. */
function fixture(sb: Sb, name: string, opts: { notes?: number; friction?: number | null; spec?: unknown } = {}): string {
  const root = join(sb.dir, name);
  for (const d of ['hooks', 'agents', 'skills/s1', 'skills/s2', 'skills/s3-workspace', 'memory/r1', 'memory/r2', 'epics/chips', 'specs']) mkdirSync(join(root, d), { recursive: true });
  for (const h of ['a.sh', 'b.sh', 'c.sh']) writeFileSync(join(root, 'hooks', h), '#!/bin/sh\n');
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '$HOME/.claude/hooks/a.sh' }, { command: '$HOME/.claude/hooks/b.sh' }] }] } }));
  writeFileSync(join(root, 'agents', 'x.md'), '# agent\n');
  writeFileSync(join(root, 'memory', 'r1', 'MEMORY.md'), '# idx\n');
  const notes = opts.notes ?? 30;
  for (let i = 0; i < notes; i++) writeFileSync(join(root, 'memory', i % 2 ? 'r1' : 'r2', `n${i}.md`), 'note\n');
  writeFileSync(join(root, 'epics', 'chips', 'c1.md'), '---\nstatus: open\n---\n');
  writeFileSync(join(root, 'epics', 'chips', 'c2.md'), '---\nstatus: fixed\n---\n');
  if (opts.friction !== null) writeFileSync(join(sb.stateDir, 'personal-friction.jsonl'), Array.from({ length: opts.friction ?? 40 }, () => '{}').join('\n') + '\n');
  writeFileSync(join(root, 'specs', 'schedule.json'), typeof opts.spec === 'string' ? opts.spec : JSON.stringify(opts.spec ?? SPEC));
  writeFileSync(join(root, 'README.md'), `# x\n\n<!-- inventory:begin (генерируется) -->\nСнимок **01.01.2026**, сгенерирован из файлов:\n\n${inventoryData(root).join('\n')}\n<!-- inventory:end -->\n`);
  return root;
}
function state(sb: Sb, entries: Record<string, { last_run: string | null; first_seen?: string; signals: Record<string, number> }>): void {
  writeFileSync(join(sb.stateDir, 'schedule-state.json'), JSON.stringify(entries));
}
function ctxFor(sb: Sb, root: string): GateContext {
  return { event: 'session-start', payload: payload('SessionStart', { source: 'startup' }, root) as never, env: { HOME: sb.home, CLAUDE_PROJECT_DIR: root }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => NOW };
}
const text = (v: ReturnType<typeof decide>) => (v as { text: string }).text ?? '';
const okState = { 'memory-review': { last_run: today, signals: { memory_notes: 30 } }, 'friction-review': { last_run: today, signals: { friction_events: 40 } } };

describe(NAME, () => {
  it('counts the inventory from files the way the shell script phrases it (3 hooks, 2 wired, unwired named, skills without -workspace)', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo');
    assert.deepEqual(inventoryData(root), [
      '- `hooks/*.sh`: 3; из них 2 подключены в `settings.json`;',
      '- не зарегистрированы как lifecycle hooks: `c.sh`;',
      '- `agents/*.md`: 1;',
      '- верхнеуровневых authored skills: 2;',
      '- project-memory roots: 2, файлов памяти: 31.',
    ]);
    sb.cleanup();
  });

  it('is silent when README matches the files and every rule was run today with unchanged signals', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo'); state(sb, okState);
    assert.equal(decide(ctxFor(sb, root)).kind, 'silent');
    sb.cleanup();
  });

  it('names the README drift with old/new lines when a hook appears, and leaves README untouched', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo'); state(sb, okState);
    writeFileSync(join(root, 'hooks', 'd.sh'), '#!/bin/sh\n');
    const before = readFileSync(join(root, 'README.md'), 'utf8');
    const v = decide(ctxFor(sb, root));
    assert.equal(v.kind, 'context');
    assert.match(text(v), /readme-inventory: блок «Проверенный состав» разошёлся с фактом/);
    assert.match(text(v), /< - `hooks\/\*\.sh`: 3; из них 2/);
    assert.match(text(v), /> - `hooks\/\*\.sh`: 4; из них 2/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), before);
    sb.cleanup();
  });

  it('reports every rule as unknown on an empty state — never ok — and does not seed the state file', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo');
    const v = decide(ctxFor(sb, root));
    assert.equal(v.kind, 'context');
    assert.match(text(v), /\? unknown \/memory-review {3}прогон никогда не отмечался/);
    assert.match(text(v), /\? unknown \/friction-review/);
    assert.doesNotMatch(text(v), /✓ ok/);
    assert.equal(existsSync(join(sb.stateDir, 'schedule-state.json')), false, 'гейт только читает');
    sb.cleanup();
  });

  it('turns due at delta >= threshold and stays quiet one below it (both sides)', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo');
    state(sb, { ...okState, 'memory-review': { last_run: ago(10), signals: { memory_notes: 30 - 25 } } });
    assert.match(text(decide(ctxFor(sb, root))), /▶ due {5}\/memory-review {3}\+25 memory_notes \(порог 25\)/);
    state(sb, { ...okState, 'memory-review': { last_run: ago(10), signals: { memory_notes: 30 - 24 } } });
    assert.equal(decide(ctxFor(sb, root)).kind, 'silent');
    sb.cleanup();
  });

  it('turns due on the time ceiling without any growth, and holds a due rule that ran more recently than the floor', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo');
    state(sb, { ...okState, 'memory-review': { last_run: ago(30), signals: { memory_notes: 30 } } });
    assert.match(text(decide(ctxFor(sb, root))), /▶ due {5}\/memory-review {3}30д с прогона \(потолок 21\)/);
    state(sb, { ...okState, 'memory-review': { last_run: today, signals: { memory_notes: 0 } } });
    const held = text(decide(ctxFor(sb, root)));
    assert.match(held, /· held {4}\/memory-review .*придержано до 5д/);
    assert.doesNotMatch(held, /▶ due/);
    sb.cleanup();
  });

  it('reports a missing signal source as unknown rather than zero even after a run was marked', () => {
    const sb = sandbox('harness-ss-'); const root = fixture(sb, 'repo', { friction: null }); state(sb, okState);
    const v = decide(ctxFor(sb, root));
    assert.match(text(v), /\? unknown \/friction-review источник сигнала friction_events отсутствует/);
    assert.doesNotMatch(text(v), /memory-review/);
    sb.cleanup();
  });

  it('is silent in a repository without inventory markers or a schedule spec, and unknown when the spec is unreadable', () => {
    const sb = sandbox('harness-ss-');
    const other = join(sb.dir, 'other'); mkdirSync(other); writeFileSync(join(other, 'README.md'), '# plain\n');
    assert.equal(decide(ctxFor(sb, other)).kind, 'silent');
    const broken = fixture(sb, 'broken', { spec: '{not json' }); state(sb, okState);
    const v = decide(ctxFor(sb, broken));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /schedule\.json нечитаем/);
    assert.equal(scheduleReport(join(sb.dir, 'nowhere'), sb.stateDir, today).kind, 'absent');
    sb.cleanup();
  });

  // Паритет держался с bash-оригиналом, пока тот был жив. Он удалён на cut-over: на нулевом числе
  // подключённых bash-хуков `grep` без совпадений под `set -o pipefail` давал rc 1 БЕЗ единой строки,
  // и сверка инвентаря молча «не проходила» — тест поверх такого оригинала подтверждал бы тишину.
  // Реализаций блока осталось две, и расходиться им нельзя: гейт сессии и CLI скрипта.
  it('agrees with harness/scripts/readme-inventory.ts on this very tree — two live implementations, one answer', async () => {
    const tree = join(HARNESS_ROOT, '..');
    const cli = await import('../../scripts/readme-inventory.ts');
    assert.deepEqual(inventoryData(tree), cli.dataLines(cli.counts(tree)), 'гейт и CLI считают состав по-разному');
    const drift = readmeDrift(tree);
    const cliRc = cli.run(['--check'], { root: tree }).rc;
    assert.equal(drift.status === 'ok', cliRc === 0, JSON.stringify(drift));
  });

  // Событие делят два гейта (второй — friction-prefilter), поэтому «весь route молчит» больше не
  // означает «этот гейт выключен»: выключатель проверяется по СВОЕМУ следу — состояние не засеяно.
  it('is skipped by its kill-switch through route(): no state file created, and silent when the event has no other speaker', async () => {
    const sb = sandbox('harness-ss-kill-'); const root = fixture(sb, 'repo');
    const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_PROJECT_DIR: root };
    await route('session-start', payload('SessionStart', { source: 'startup' }, root) as never, { ...base, [KILL]: '1' });
    assert.equal(existsSync(join(sb.stateDir, 'schedule-state.json')), false, 'выключенный гейт засеял состояние');
    const v = await route('session-start', payload('SessionStart', { source: 'startup' }, root) as never, { ...base, [KILL]: '1', CLAUDE_SKIP_PREFILTER: '1' });
    assert.equal(v.kind, 'silent');
    assert.equal(existsSync(join(sb.stateDir, 'schedule-state.json')), false);
    sb.cleanup();
  });

  after(() => { /* каждый кейс убирает свой sandbox */ });
});
