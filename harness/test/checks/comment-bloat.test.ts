// Порт hooks/comment-bloat-check.sh: правило «комментарии по делу» держалось на памяти модели и не держалось.
// INVARIANT: оцениваются только ДОБАВЛЕННЫЕ строки; шапка файла (первые 15 строк) не считается блоком;
// комментарии определяются по AST TypeScript, а не по началу строки — regex-литерал `/\/\/ x/` комментарием не является.
// REGRESSION: история правки внутри хвостового `// …` после кода тоже ловится (текстовый хук её не видел).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../_env.ts';
import { initRepo, changed, ctx, TS_PATH } from './_repo.ts';
import { checker } from '../../src/checks/comment-bloat.ts';
import { CHECKERS } from '../../src/checks/registry.ts';

const header = Array.from({ length: 16 }, (_, i) => `// header line ${i + 1}`).join('\n');
const BASE = `${header}\nexport function a(): number {\n  return 1;\n}\n`;
const comments = (n: number, word = 'note') => Array.from({ length: n }, (_, i) => `  // ${word} ${i + 1}`).join('\n');

describe('comment-bloat checker', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('registers as sync with the bash kill-switch name and skips prose/data files and deleted files', () => {
    assert.ok(CHECKERS.some((c) => c.name === 'comment-bloat'));
    assert.equal(checker.tier, 'sync');
    assert.equal(checker.killSwitch, 'CLAUDE_SKIP_COMMENT_CHECK');
    const f = { repo: '/r', path: 'a.ts', absPath: '/r/a.ts', digest: '0', status: 'M' } as const;
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx']) assert.equal(checker.applies({ ...f, path: p, absPath: `/r/${p}` }), true, p);
    for (const p of ['a.md', 'a.json', 'a.lock', 'a.snap', 'a.txt', 'a.sh', 'a.py']) assert.equal(checker.applies({ ...f, path: p, absPath: `/r/${p}` }), false, p);
    assert.equal(checker.applies({ ...f, status: 'D' }), false);
  });

  it('fails on an added contiguous comment block longer than 5 lines outside the header and names its line range', async () => {
    const repo = initRepo(sb, 'r-block');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', `${comments(6)}\n  return 1;`));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /строки 18-23: сплошной комментарий на 6 строк/);
  });

  it('passes a block of exactly 5 lines — the threshold is strict', async () => {
    const repo = initRepo(sb, 'r-five');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', `${comments(5)}\n  return 1;`));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('passes a long block that starts inside the header — the module contract is a legitimate genre', async () => {
    const repo = initRepo(sb, 'r-header');
    repo.write('a.ts', 'export const x = 1;\n'); repo.commitAll();
    repo.write('a.ts', `${Array.from({ length: 9 }, (_, i) => `// contract ${i}`).join('\n')}\nexport const x = 1;\n`);
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('honours COMMENT_MAX_BLOCK and COMMENT_HEADER_LINES from the environment', async () => {
    const repo = initRepo(sb, 'r-env');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', `${comments(3)}\n  return 1;`));
    const strict = await checker.run(changed(repo, 'a.ts'), ctx(sb, { CLAUDE_HARNESS_TS: TS_PATH, COMMENT_MAX_BLOCK: '2' }));
    assert.equal(strict.verdict, 'fail');
    assert.match(strict.message ?? '', /порог 2/);
    const wideHeader = await checker.run(changed(repo, 'a.ts'), ctx(sb, { CLAUDE_HARNESS_TS: TS_PATH, COMMENT_MAX_BLOCK: '2', COMMENT_HEADER_LINES: '40' }));
    assert.equal(wideHeader.verdict, 'pass');
  });

  it('fails when added comments outnumber added code two to one on a change of at least 4 code lines', async () => {
    const repo = initRepo(sb, 'r-ratio');
    repo.write('a.ts', BASE); repo.commitAll();
    const body = ['  const a = 1;', comments(4, 'a'), '  const b = 2;', comments(4, 'b'), '  const c = 3;', '  return a + b + c;'].join('\n');
    repo.write('a.ts', BASE.replace('  return 1;', body));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /в правке 8 строк комментариев на 4 строк кода/);
  });

  it('passes the same ratio on a tiny change — fewer than 4 code lines is not a signal', async () => {
    const repo = initRepo(sb, 'r-tiny');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', ['  const a = 1;', comments(4, 'a'), '  const b = a;', comments(4, 'b'), '  return b;'].join('\n')));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('fails on edit history inside added comments — a date, «раньше», a commit hash — with the line number', async () => {
    const repo = initRepo(sb, 'r-history');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', '  // fixed 27.07.2026 after incident\n  // раньше возвращали ноль\n  return 1; // see commit deadbeef1'));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /строка 18: «27\.07\.2026»/);
    assert.match(r.message ?? '', /строка 19: «раньше»/);
    assert.match(r.message ?? '', /строка 20: «commit deadbeef1»/);
  });

  it('ignores history words in string literals and in a regex literal that looks like a comment', async () => {
    const repo = initRepo(sb, 'r-literals');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', "  const s = 'раньше было 27.07.2026';\n  const re = /\\/\\/ раньше/;\n  return s.length + re.source.length;"));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'pass', r.message);
  });

  it('ignores old comments with history words — only added lines are judged', async () => {
    const repo = initRepo(sb, 'r-old');
    const base = BASE.replace('  return 1;', '  // раньше было иначе, 01.01.2020\n  return 1;');
    repo.write('a.ts', base); repo.commitAll();
    repo.write('a.ts', base.replace('return 1', 'return 2'));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('treats an untracked file as all-added — a fresh file with a 6-line block after the header fails', async () => {
    const repo = initRepo(sb, 'r-new');
    repo.write('base.ts', 'export const x = 1;\n'); repo.commitAll();
    repo.write('fresh.ts', BASE.replace('  return 1;', `${comments(6)}\n  return 1;`));
    const r = await checker.run(changed(repo, 'fresh.ts', '?'), ctx(sb));
    assert.equal(r.verdict, 'fail');
  });

  it('answers unknown without typescript and unknown outside git — never a silent pass', async () => {
    const repo = initRepo(sb, 'r-unknown');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', `${comments(6)}\n  return 1;`));
    const noTs = await checker.run(changed(repo, 'a.ts'), ctx(sb, {}));
    assert.equal(noTs.verdict, 'unknown');
    assert.match(noTs.missing_reason ?? '', /typescript/i);
    const dir = join(sb.dir, 'nogit'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b.ts'), BASE);
    const noGit = await checker.run({ repo: dir, path: 'b.ts', absPath: join(dir, 'b.ts'), digest: '0', status: 'M' }, ctx(sb));
    assert.equal(noGit.verdict, 'unknown');
  });
});
