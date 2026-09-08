// INVARIANT К2/К3/К5: контур не зависит от bash-семантики и платформенных команд. Мета-тест держит форму:
// strip-only синтаксис TypeScript (enum/namespace/parameter properties не стрипаются Node 24 — упадут на боевом событии),
// запрещённые API вне объявленных точек, импорты с расширением .ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { HARNESS_ROOT } from '../_env.ts';

function walk(d: string): string[] { return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; }); }
const SRC = [...walk(join(HARNESS_ROOT, 'src')), ...walk(join(HARNESS_ROOT, 'scripts'))];
const rel = (p: string) => relative(HARNESS_ROOT, p);

// Единственные точки прямого запуска процессов: platform.spawnTool (allowlist), sweep.spawnWorker (detached),
// session/git-freshness (detached fetch — объявленное исключение).
const CHILD_PROCESS_ALLOW = new Set(['src/platform.ts', 'src/sweep.ts', 'src/session/git-freshness.ts']);
const FORBIDDEN: Array<[RegExp, string, Set<string>]> = [
  [/\bos\.freemem\b/, 'os.freemem — на macOS показывает свободные страницы, не доступную память', new Set()],
  [/\bvm_stat\b|\bsysctl\b|\bstat -f\b|\bdate -j\b/, 'платформенная команда вне platform.ts', new Set(['src/platform.ts'])],
  [/(^|[^A-Za-z])jq\s+['"-]|python3 -c|\bperl\b|\bshasum\b/, 'jq/python3 -c/perl/shasum — К5', new Set()],
  [/from 'node:child_process'|require\('child_process'\)/, 'child_process вне объявленных точек', CHILD_PROCESS_ALLOW],
  [/\bexecSync\(|\bexecFileSync\(|\bspawnSync\(/, 'execSync/execFileSync/spawnSync — только spawnTool', new Set(['src/platform.ts'])],
  [/^\s*enum\s+\w+|^\s*namespace\s+\w+|constructor\((public|private|protected|readonly)\s/m, 'синтаксис, который Node 24 не стрипает', new Set()],
  [/from '\.[^']*(?<!\.ts)'/, 'относительный импорт без расширения .ts', new Set()],
];

describe('lint', () => {
  it('every src/scripts module survives stripTypeScriptTypes in strip mode — no enum, namespace or parameter properties', () => {
    for (const f of SRC) assert.doesNotThrow(() => stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'strip' }), rel(f));
  });
  for (const [re, why, allow] of FORBIDDEN) {
    it(`forbids ${why}`, () => {
      const hits = SRC.filter((f) => !allow.has(rel(f))).filter((f) => re.test(readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, ''))).map(rel);
      assert.deepEqual(hits, [], why);
    });
  }
  it('has no direct git invocation outside src/git.ts and the declared fetch exception', () => {
    const hits = SRC.filter((f) => !new Set(['src/git.ts', 'src/session/git-freshness.ts']).has(rel(f))).filter((f) => /spawnTool\(\s*'git'/.test(readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(hits, []);
  });
});
