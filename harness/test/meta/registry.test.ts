// INVARIANT I4/К2: гейт или проверка без двусторонних тестов и kill-switch не существует. Класс `vacuous`
// (deny-gates.test.sh:6-8) — гейт, проверенный с одной стороны, месяц жил константой.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import '../../src/gates/index.ts';
import { GATES } from '../../src/gates/registry.ts';
import { CHECKERS } from '../../src/checks/registry.ts';
import { HARNESS_ROOT, sandbox, payload } from '../_env.ts';
import { route } from '../../src/main.ts';
import type { Verdict } from '../../src/types.ts';


// Кандидаты: всё, что лежит в каталогах модулей и не является служебным файлом реестра.
// Список берётся с диска, поэтому новый модуль попадает под проверку без правки теста.
const SERVICE = new Set(['index.ts', 'registry.ts', 'types.ts', 'prefilters.ts']);
const registrable = (): string[] => {
  const src = join(HARNESS_ROOT, 'src');
  const dirs = ['gates', 'checks', 'session'].flatMap((d) => {
    const dir = join(src, d);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts') && !SERVICE.has(f)).map((f) => join(dir, f)) : [];
  });
  const top = ['friction.ts', 'telemetry.ts'].map((f) => join(src, f)).filter(existsSync);
  // scripts/ тоже: гейт префильтра лежал ТАМ, был готов и не подключён — каталог вне обзора
  // повторил ровно тот класс, ради которого этот тест написан (граница проверки уже границы правила).
  const scripts = existsSync(join(HARNESS_ROOT, 'scripts'))
    ? readdirSync(join(HARNESS_ROOT, 'scripts')).filter((f) => f.endsWith('.ts') && !SERVICE.has(f)).map((f) => join(HARNESS_ROOT, 'scripts', f))
    : [];
  return [...dirs, ...top, ...scripts].sort();
};

describe('registry', () => {
  it('registers at least the sweep gates and the three built-in checkers', () => {
    assert.ok(GATES.some((g) => g.name === 'sweep')); assert.ok(GATES.some((g) => g.name === 'sweep-stop'));
    for (const c of ['syntax', 'project-check', 'tsc-project']) assert.ok(CHECKERS.some((x) => x.name === c), c);
  });
  // Текстовая проверка «имя выключателя встречается в тексте теста» пропускала обращение по КОНСТАНТЕ
  // (`env[KILL] = '1'`) и красила шесть корректно закрытых гейтов. Проверяется поведение роутера:
  // с выключателем гейт не вызывается ВОВСЕ (I4 — раньше любой записи), без него вызывается на своём событии.
  for (const g of GATES) {
    it(`gate ${g.name} is not invoked at all under ${g.killSwitch}=1 and is invoked without it`, async () => {
      assert.match(g.killSwitch, /^CLAUDE_SKIP_[A-Z_]+$/);
      assert.ok(g.events.length > 0, 'гейт без событий не вызывается никогда');
      const sb = sandbox('harness-killswitch-');
      const calls = new Map<string, number>();
      const originals = GATES.map((x) => [x, x.run] as const);
      for (const x of GATES) x.run = () => { calls.set(x.name, (calls.get(x.name) ?? 0) + 1); return { kind: 'silent' } as Verdict; };
      const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
      try {
        const ev = g.events[0];
        await route(ev, payload('Stop', {}, sb.dir) as never, { ...base, [g.killSwitch]: '1' });
        assert.equal(calls.get(g.name) ?? 0, 0, `${g.killSwitch}=1 не остановил вызов`);
        await route(ev, payload('Stop', {}, sb.dir) as never, base);
        assert.equal(calls.get(g.name) ?? 0, 1, `без ${g.killSwitch} гейт не вызван на событии ${ev}`);
      } finally {
        for (const [x, run] of originals) x.run = run;
        sb.cleanup();
      }
    });
  }
  for (const c of CHECKERS) {
    it(`checker ${c.name} declares tier and kill-switch`, () => { assert.ok(['sync', 'worker'].includes(c.tier)); assert.match(c.killSwitch, /^CLAUDE_SKIP_/); });
  }
  it('names are unique across gates and checkers', () => {
    const names = [...GATES.map((g) => g.name), ...CHECKERS.map((c) => c.name)];
    assert.equal(new Set(names).size, names.length);
  });

  // REGRESSION 2026-09-05: восемь гейтов, четыре проверки и восемь session-модулей были
  // портированы, зелены (530 тестов) и НЕ подключены — `gates/index.ts` их не импортировал,
  // роутер грузил 2 гейта из 22. Тесты этого не видели: каждый импортирует свой модуль сам,
  // а этот файл до правки итерировал только по УЖЕ зарегистрированным. Проверка идёт от диска,
  // а не от реестра, и не разбирает исходник: модуль импортируется — реестр вырос ⇒ он не в index.
  it('a module that registers a gate or checker is imported from src/gates/index.ts — the router loads nothing else', async () => {
    const known = new Set([...GATES.map((g) => g.name), ...CHECKERS.map((c) => c.name)]);
    const unwired: string[] = [];
    for (const file of registrable()) {
      await import(pathToFileURL(file).href);
      const added = [...GATES.map((g) => g.name), ...CHECKERS.map((c) => c.name)].filter((n) => !known.has(n));
      if (added.length) unwired.push(`${relative(HARNESS_ROOT, file)} → ${added.join(', ')}`);
      for (const n of added) known.add(n);
    }
    assert.deepEqual(unwired, [], `регистрируются, но не импортируются из index:\n${unwired.join('\n')}`);
  });

  it('the candidate list is not empty and covers all three module directories — an empty scan would make the check above vacuous', () => {
    const dirs = new Set(registrable().map((f) => relative(join(HARNESS_ROOT, 'src'), f).split('/')[0]));
    for (const d of ['gates', 'checks', 'session']) assert.ok(dirs.has(d), `каталог ${d} не попал в скан`);
    assert.ok(registrable().length >= 20, `кандидатов ${registrable().length} — скан подозрительно узок`);
  });
});
