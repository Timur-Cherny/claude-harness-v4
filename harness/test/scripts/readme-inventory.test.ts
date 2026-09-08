// Свой корпус (у bash-оригинала спека не было). INVARIANT: числа в README — производная от файлов:
// --check краснеет ровно при дрейфе и не трогает дерево; --sync переписывает только блок между маркерами,
// а дату снимка меняет только вместе с данными; отсутствие маркеров или settings.json — ошибка, не «0».
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../_env.ts';
import { run, counts, dataLines, currentData } from '../../scripts/readme-inventory.ts';

const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime();
let seq = 0;
const PREFIX = '# Мозг\n\nпроза до блока\n\n<!-- inventory:begin (генерируется, руками не править) -->\n';
const SUFFIX = '<!-- inventory:end -->\n\nпроза после блока\n';

/** Корень с 3 хуками (2 подключены), 2 агентами, 2 скиллами + workspace, памятью 2 корня / 3 файла. */
function fixture(sb: ReturnType<typeof sandbox>, block: string | null): { root: string; opts: { root: string; now: () => number } } {
  const root = join(sb.dir, `inv${++seq}`);
  for (const d of ['hooks/spec', 'agents', 'skills/a', 'skills/b', 'skills/b-workspace', 'memory/r1/deep', 'memory/r2']) mkdirSync(join(root, d), { recursive: true });
  for (const h of ['alpha.sh', 'beta.sh', 'gamma.sh']) writeFileSync(join(root, 'hooks', h), '');
  writeFileSync(join(root, 'hooks', 'spec', 'x.test.sh'), ''); writeFileSync(join(root, 'hooks', 'notes.md'), '');
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'bash ~/.claude/hooks/beta.sh' }, { command: 'sh ~/.claude/hooks/alpha.sh --flag' }] }] }, other: 'hooks/readme.md' }));
  for (const a of ['one.md', 'two.md']) writeFileSync(join(root, 'agents', a), '');
  writeFileSync(join(root, 'memory', 'r1', 'MEMORY.md'), ''); writeFileSync(join(root, 'memory', 'r1', 'deep', 'n.md'), ''); writeFileSync(join(root, 'memory', 'r2', 'n.md'), ''); writeFileSync(join(root, 'memory', 'r2', 'x.txt'), '');
  if (block !== null) writeFileSync(join(root, 'README.md'), PREFIX + block + SUFFIX);
  return { root, opts: { root, now: () => NOW } };
}
const EXPECTED = [
  '- `hooks/*.sh`: 3; из них 2 подключены в `settings.json`;',
  '- не зарегистрированы как lifecycle hooks: `gamma.sh`;',
  '- `agents/*.md`: 2;',
  '- верхнеуровневых authored skills: 2;',
  '- project-memory roots: 2, файлов памяти: 3.',
];
const readme = (root: string) => readFileSync(join(root, 'README.md'), 'utf8');

describe('scripts/readme-inventory', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('counts hooks, wired hooks, agents, non-workspace skills and memory from file names only', () => {
    const f = fixture(sb, '');
    const c = counts(f.root);
    assert.deepEqual([c.hooks_total, c.wired, c.unwired, c.agents, c.skills, c.mem_roots, c.mem_files], [3, ['alpha.sh', 'beta.sh'], ['gamma.sh'], 2, 2, 2, 3]);
    assert.deepEqual(dataLines(c), EXPECTED);
  });

  it('passes --check with rc 0 when the block matches the facts regardless of the snapshot date', () => {
    const f = fixture(sb, `Снимок **01.01.2020**, сгенерирован из файлов (x):\n\n${EXPECTED.join('\n')}\n`);
    assert.deepEqual(run(['--check'], f.opts), { rc: 0, stdout: '', stderr: '' });
    assert.deepEqual(run([], f.opts), { rc: 0, stdout: '', stderr: '' });
    assert.match(readme(f.root), /01\.01\.2020/, 'без дрейфа дата снимка не переписывается');
  });

  it('fails --check with rc 1, a diff on stderr and an untouched README when a number drifted', () => {
    const stale = [...EXPECTED]; stale[2] = '- `agents/*.md`: 7;';
    const f = fixture(sb, `Снимок **01.01.2020**, x:\n\n${stale.join('\n')}\n`);
    const before = readme(f.root);
    const r = run(['--check'], f.opts);
    assert.equal(r.rc, 1); assert.match(r.stderr, /разошёлся с фактом/); assert.match(r.stderr, /< - `agents\/\*\.md`: 7;\n> - `agents\/\*\.md`: 2;/);
    assert.equal(readme(f.root), before);
  });

  it('rewrites only the block on --sync with today\'s snapshot date, after which --check passes', () => {
    const f = fixture(sb, 'Снимок **01.01.2020**, x:\n\n- мусор\n');
    assert.deepEqual(run(['--sync'], f.opts), { rc: 0, stdout: '', stderr: '' });
    const after_ = readme(f.root);
    assert.ok(after_.startsWith(PREFIX) && after_.endsWith(SUFFIX), 'проза вокруг блока не тронута');
    assert.deepEqual(currentData(after_), EXPECTED);
    assert.match(after_, /Снимок \*\*05\.09\.2026\*\*, сгенерирован из файлов/);
    assert.equal(run(['--check'], f.opts).rc, 0);
  });

  it('renders «—» when every hook is wired, and counts a hook string with extra words once', () => {
    const f = fixture(sb, '');
    writeFileSync(join(f.root, 'settings.json'), JSON.stringify({ a: 'bash hooks/alpha.sh', b: 'bash hooks/beta.sh && bash hooks/gamma.sh', c: 'bash hooks/alpha.sh' }));
    const c = counts(f.root);
    assert.deepEqual(c.unwired, []); assert.equal(dataLines(c)[1], '- не зарегистрированы как lifecycle hooks: —;');
  });

  it('fails with rc 1 when the markers are missing and when README is absent — never syncs into nothing', () => {
    const f = fixture(sb, ''); writeFileSync(join(f.root, 'README.md'), '# без маркеров\n');
    const r = run(['--check'], f.opts); assert.equal(r.rc, 1); assert.match(r.stderr, /маркеры inventory:begin\/end не найдены/);
    assert.equal(run(['--sync'], f.opts).rc, 1); assert.equal(readme(f.root), '# без маркеров\n');
    const g = fixture(sb, null); assert.equal(run(['--check'], g.opts).rc, 1);
  });

  it('declares the inventory unknown (rc 1) when settings.json is unreadable instead of counting 0 wired hooks', () => {
    const f = fixture(sb, `Снимок **x**:\n\n${EXPECTED.join('\n')}\n`); rmSync(join(f.root, 'settings.json'));
    const r = run(['--check'], f.opts); assert.equal(r.rc, 1); assert.match(r.stderr, /инвентарь неизвестен/);
  });

  it('rejects an unknown argument with rc 2 instead of treating it as --sync', () => {
    const f = fixture(sb, '- мусор\n');
    const r = run(['--bogus'], f.opts); assert.equal(r.rc, 2); assert.match(r.stderr, /неизвестный аргумент --bogus/);
    assert.equal(run(['--root'], f.opts).rc, 2); assert.equal(run(['--check', 'extra'], f.opts).rc, 2);
    assert.match(readme(f.root), /- мусор/, 'ошибка аргументов README не трогает');
  });
});
