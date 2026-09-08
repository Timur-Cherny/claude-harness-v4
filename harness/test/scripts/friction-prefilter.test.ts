// Порт hooks/spec/prefilter-registries.test.sh: реестры разделены, старение общее.
// INVARIANT: дефолтный вызов (вход /friction-review) не видит чужой домен; закрытая находка не стареет;
// открытая находка без даты объявляется несостаримой, а не пропадает. Отсутствующий каталог реестра — unknown (I1).
// Тест ГЕРМЕТИЧЕН: первая bash-редакция мерила живые чипы репозитория и покраснела, когда их закрыли.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload } from '../_env.ts';
import { run, prefilter, frontmatter, PREFILTER_GATE, KILL_SWITCH } from '../../scripts/friction-prefilter.ts';
import { localDate } from '../../scripts/due.ts';
import { route } from '../../src/main.ts';
import { GATES, register } from '../../src/gates/registry.ts';

const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime();
const today = localDate(NOW);
let seq = 0;

function chip(dir: string, name: string, status: string, discovered: string | null, closeWhen = ''): void {
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\nstatus: ${status}\n${discovered ? `discovered: ${discovered}\n` : ''}close_when: ${closeWhen}\n---\nт\n`);
}

/** $1 = статус чипа, $2 = статус узла графа — как mkfix в bash-корпусе. */
function mkfix(sb: ReturnType<typeof sandbox>, chipStatus: string, nodeStatus: string): { root: string; opts: { root: string; now: () => number; env: Record<string, string> } } {
  const root = join(sb.dir, `fix${++seq}`);
  for (const d of ['epics/chips', 'graph/incidents', 'specs']) mkdirSync(join(root, d), { recursive: true });
  chip(join(root, 'epics', 'chips'), 'CHIP_probe', chipStatus, '2020-01-01');
  writeFileSync(join(root, 'graph', 'incidents', 'i.md'), `---\nid: INC-PROBE\nstatus: ${nodeStatus}\ndiscovered: 2020-01-01\nclose_when: тест краснеет до фикса\n---\nт\n`);
  return { root, opts: { root, now: () => NOW, env: {} } };
}
const pf = (o: { opts: { root: string; now: () => number; env: Record<string, string> } }, ...argv: string[]) => run(argv, o.opts);

describe('scripts/friction-prefilter', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('shows the graph and hides the chips by default — the /friction-review domain is not mixed with WMS', () => {
    const f = mkfix(sb, 'open', 'open'); const out = pf(f).stdout;
    assert.match(out, /INC-PROBE/); assert.doesNotMatch(out, /CHIP_probe/);
    assert.match(out, /^2439д  open       INC-PROBE  close_when: тест краснеет до фикса$/m);
  });

  it('shows only the chips with --registry chips — the other side of the boundary', () => {
    const f = mkfix(sb, 'open', 'open'); const out = pf(f, '--registry', 'chips').stdout;
    assert.match(out, /CHIP_probe/); assert.doesNotMatch(out, /INC-PROBE/);
  });

  it('prints both registries under their own headers with --registry all', () => {
    const out = pf(mkfix(sb, 'open', 'open'), '--registry', 'all').stdout;
    assert.match(out, /— граф инцидентов —/); assert.match(out, /— чипы эпика \(домен WMS\) —/);
  });

  it('prints no header over an empty registry', () => {
    const out = pf(mkfix(sb, 'closed', 'open'), '--registry', 'all').stdout;
    assert.match(out, /— граф инцидентов —/); assert.doesNotMatch(out, /— чипы эпика/);
  });

  it('is fully silent when every finding is closed — closed does not age (both sides of the status)', () => {
    assert.deepEqual(pf(mkfix(sb, 'closed', 'closed'), '--registry', 'all'), { rc: 0, stdout: '', stderr: '' });
  });

  it('caps each registry at 5 rows in all-mode and returns everything on a direct registry call', () => {
    const f = mkfix(sb, 'open', 'closed');
    for (let i = 2; i <= 8; i++) chip(join(f.root, 'epics', 'chips'), `CHIP_p${i}`, 'open', '2020-01-01');
    const all = pf(f, '--registry', 'all').stdout;
    assert.match(all, /…и ещё 3 старше 14д/); assert.ok((all.match(/CHIP_/g) ?? []).length <= 5, all);
    assert.equal((pf(f, '--registry', 'chips').stdout.match(/CHIP_/g) ?? []).length, 8);
  });

  it('declares an open finding without a date as «состарить нечем» instead of dropping it', () => {
    const f = mkfix(sb, 'open', 'closed');
    rmSync(join(f.root, 'epics', 'chips', 'CHIP_probe.md')); chip(join(f.root, 'epics', 'chips'), 'CHIP_no_anchor', 'open', null);
    const out = pf(f, '--registry', 'chips').stdout;
    assert.match(out, /без даты/); assert.match(out, /CHIP_no_anchor/);
  });

  it('stays silent for a fresh open finding with close_when', () => {
    const f = mkfix(sb, 'open', 'closed');
    rmSync(join(f.root, 'epics', 'chips', 'CHIP_probe.md')); chip(join(f.root, 'epics', 'chips'), 'CHIP_fresh', 'open', today, 'тест краснеет');
    assert.equal(pf(f, '--registry', 'chips').stdout, '');
  });

  it('rejects an unknown registry, an unknown argument, a bare --registry and a bare --root — rc 2 each, different reasons', () => {
    const f = mkfix(sb, 'open', 'open');
    const cases: Array<[string[], RegExp]> = [[['--registry', 'nosuch'], /неизвестный реестр nosuch/], [['--bogus'], /неизвестный аргумент --bogus/], [['--registry'], /без значения/], [['--root'], /--root требует/]];
    for (const [argv, re] of cases) { const r = pf(f, ...argv); assert.equal(r.rc, 2, argv.join(' ')); assert.match(r.stderr, re); assert.equal(r.stdout, ''); }
  });

  it('honours FRICTION_AGE_DAYS on both sides of the threshold', () => {
    const f = mkfix(sb, 'open', 'closed');
    rmSync(join(f.root, 'epics', 'chips', 'CHIP_probe.md')); chip(join(f.root, 'epics', 'chips'), 'CHIP_ten', 'open', localDate(NOW - 10 * 86400000), 'x');
    assert.equal(run(['--registry', 'chips'], { ...f.opts, env: { FRICTION_AGE_DAYS: '11' } }).stdout, '');
    assert.match(run(['--registry', 'chips'], { ...f.opts, env: { FRICTION_AGE_DAYS: '10' } }).stdout, /^  10д  open       CHIP_ten/m);
  });

  it('flags the EVAL.md placeholder obligation, the overdue «Следующий замер» and the waiting spec — and not their satisfied counterparts', () => {
    const f = mkfix(sb, 'closed', 'closed');
    writeFileSync(join(f.root, 'graph', 'EVAL.md'), '**Обязательство:** снять baseline от 2026-01-01\n| — | — |\n**Следующий замер: 2026-09-01**\n');
    writeFileSync(join(f.root, 'specs', 'SPEC_FRICTION_LEDGER.md'), '**Дата:** 2026-01-10 · **Статус:** 🟡 ждёт данных · x\n');
    const out = pf(f).stdout;
    assert.match(out, /^ 247д  журнал     graph\/EVAL\.md  baseline\/прогоны не сняты \(обязательство от 2026-01-01\)$/m);
    assert.match(out, /^   4д  журнал     graph\/EVAL\.md  «Следующий замер» просрочен \(был назначен на 2026-09-01\)$/m);
    assert.match(out, /^ 238д  спека      SPEC_FRICTION_LEDGER\.md  статус «🟡 ждёт данных» не пересматривался$/m);
    writeFileSync(join(f.root, 'graph', 'EVAL.md'), '**Обязательство:** снять baseline от 2026-01-01\n| 12 | 3 |\n**Следующий замер: 2026-12-01**\n');
    writeFileSync(join(f.root, 'specs', 'SPEC_FRICTION_LEDGER.md'), '**Дата:** 2026-01-10 · **Статус:** ✅ принято · x\n');
    assert.equal(pf(f).stdout, '');
  });

  it('reports a missing registry directory as unknown on stderr / in the gate — absence of the source is not «nothing to escalate»', () => {
    const root = join(sb.dir, 'noreg'); mkdirSync(join(root, 'epics', 'chips'), { recursive: true });
    const r = run(['--registry', 'all'], { root, now: () => NOW, env: {} });
    assert.equal(r.rc, 0); assert.match(r.stderr, /реестр graph\/incidents отсутствует — старение неизвестно/);
    assert.deepEqual(prefilter('chips', { root, now: () => NOW, env: {} }).missing, []);
    const v = PREFILTER_GATE.run({ event: 'session-start', payload: payload('SessionStart') as never, env: {}, root: join(root, 'harness'), stateDir: join(sb.dir, 'noreg-state'), now: () => NOW });
    assert.equal((v as { kind: string }).kind, 'unknown');
  });

  it('is silenced by CLAUDE_SKIP_PREFILTER=1 through route(), and returns the all-mode summary as context without it', async () => {
    const f = mkfix(sb, 'open', 'open'); const stateDir = join(sb.dir, 'kill-state'); mkdirSync(stateDir);
    if (!GATES.some((g) => g.name === PREFILTER_GATE.name)) register(PREFILTER_GATE);
    const others = Object.fromEntries(GATES.filter((g) => g.name !== PREFILTER_GATE.name).map((g) => [g.killSwitch, '1']));
    const env = { ...others, HOME: sb.home, HARNESS_ROOT: join(f.root, 'harness'), CLAUDE_STATE_DIR: stateDir };
    assert.equal((await route('session-start', payload('SessionStart') as never, { ...env, [KILL_SWITCH]: '1' })).kind, 'silent');
    assert.deepEqual(readdirSync(stateDir), []);
    const on = await route('session-start', payload('SessionStart') as never, env);
    assert.equal(on.kind, 'context'); assert.match((on as { text: string }).text, /— граф инцидентов —[\s\S]*— чипы эпика/);
  });

  it('parses only the frontmatter head: quoted values are unquoted, a file without a block is null', () => {
    const p = join(sb.dir, 'fm.md'); writeFileSync(p, '---\nid: "X-1"\nstatus: open\n---\nтело: не читается\n');
    assert.deepEqual(frontmatter(p), { id: 'X-1', status: 'open' });
    writeFileSync(p, 'no frontmatter\n'); assert.equal(frontmatter(p), null);
  });
});
