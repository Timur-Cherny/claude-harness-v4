// H14: добавленная строка комментария с кириллицей в *.ts/*.tsx → fail с номером строки. Правило языка
// комментариев держалось на памяти модели и не держалось (CHIP_comment-language-mix): обе стороны давали rc=0.
// INVARIANT: только ДОБАВЛЕННЫЕ строки и только комментарии — строковый литерал с кириллицей и старая строка не считаются.
// REGRESSION: хвостовой `// …` после кода (известная дыра текстового подхода) по AST тоже ловится.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sandbox } from '../_env.ts';
import { initRepo, changed, ctx, TS_PATH } from './_repo.ts';
import { checker } from '../../src/checks/comment-language.ts';
import { CHECKERS } from '../../src/checks/registry.ts';

const BASE = [
  '// старый комментарий с кириллицей — не считается',
  'export function a(): number {',
  '  return 1;',
  '}',
  '',
].join('\n');

describe('comment-language checker', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('registers as a sync checker with its own kill-switch and applies only to .ts/.tsx that still exist', () => {
    assert.ok(CHECKERS.some((c) => c.name === 'comment-language'));
    assert.equal(checker.tier, 'sync');
    assert.equal(checker.killSwitch, 'CLAUDE_SKIP_COMMENT_LANGUAGE');
    const f = { repo: '/r', path: 'a.ts', absPath: '/r/a.ts', digest: '0', status: 'M' } as const;
    assert.equal(checker.applies(f), true);
    assert.equal(checker.applies({ ...f, path: 'a.tsx', absPath: '/r/a.tsx' }), true);
    assert.equal(checker.applies({ ...f, path: 'a.js', absPath: '/r/a.js' }), false);
    assert.equal(checker.applies({ ...f, path: 'a.md', absPath: '/r/a.md' }), false);
    assert.equal(checker.applies({ ...f, status: 'D' }), false);
  });

  it('fails with L<n> for an added line-comment in Cyrillic and keeps silent about the old Cyrillic header', async () => {
    const repo = initRepo(sb, 'r-fail');
    repo.write('src/a.ts', BASE); repo.commitAll();
    repo.write('src/a.ts', BASE.replace('  return 1;', '  // возвращаем единицу\n  return 1;'));
    const r = await checker.run(changed(repo, 'src/a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /L3\b/);
    assert.doesNotMatch(r.message ?? '', /L1\b/);
  });

  it('fails for an added block comment and a trailing `// …` after code — the AST sees what a line-start regex misses', async () => {
    const repo = initRepo(sb, 'r-block');
    repo.write('src/b.ts', BASE); repo.commitAll();
    repo.write('src/b.ts', BASE.replace('  return 1;', '  /* первая\n     вторая */\n  return 1; // хвост'));
    const r = await checker.run(changed(repo, 'src/b.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /L3\b/);
    assert.match(r.message ?? '', /L4\b/);
    assert.match(r.message ?? '', /L5\b/);
  });

  it('passes when the added Cyrillic lives in a string literal, a template, or a TODO(MD-…) English comment', async () => {
    const repo = initRepo(sb, 'r-pass');
    repo.write('src/c.ts', BASE); repo.commitAll();
    repo.write('src/c.ts', BASE.replace('  return 1;', "  const s = 'кириллица в строке'; // TODO(MD-12): tidy\n  const t = `и в шаблоне ${s}`;\n  return t.length;"));
    const r = await checker.run(changed(repo, 'src/c.ts'), ctx(sb));
    assert.equal(r.verdict, 'pass', r.message);
  });

  it('passes an unchanged file whose only Cyrillic comments are old — added lines are the unit, not the file', async () => {
    const repo = initRepo(sb, 'r-old');
    repo.write('src/d.ts', BASE); repo.commitAll();
    repo.write('src/d.ts', BASE.replace('return 1', 'return 2'));
    const r = await checker.run(changed(repo, 'src/d.ts'), ctx(sb));
    assert.equal(r.verdict, 'pass', r.message);
  });

  it('treats an untracked file as all-added and fails on its Cyrillic comment', async () => {
    const repo = initRepo(sb, 'r-untracked');
    repo.write('src/base.ts', 'export const x = 1;\n'); repo.commitAll();
    repo.write('src/new.ts', 'export const y = 2;\n// новый файл целиком\n');
    const r = await checker.run(changed(repo, 'src/new.ts', '?'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /L2\b/);
  });

  it('passes a repo that declares `harness.comment-language = ru` — the convention is per repository, not per machine', async () => {
    const repo = initRepo(sb, 'r-ru');
    repo.git('config', 'harness.comment-language', 'ru');
    repo.write('src/e.ts', BASE); repo.commitAll();
    repo.write('src/e.ts', BASE.replace('  return 1;', '  // по-русски здесь норма\n  return 1;'));
    const r = await checker.run(changed(repo, 'src/e.ts'), ctx(sb));
    assert.equal(r.verdict, 'pass');
  });

  it('answers unknown with missing_reason when no typescript is reachable — never a silent pass', async () => {
    const repo = initRepo(sb, 'r-nots');
    repo.write('src/f.ts', BASE); repo.commitAll();
    repo.write('src/f.ts', BASE.replace('  return 1;', '  // кириллица\n  return 1;'));
    const r = await checker.run(changed(repo, 'src/f.ts'), ctx(sb, {}));
    assert.equal(r.verdict, 'unknown');
    assert.match(r.missing_reason ?? '', /typescript/i);
  });

  it('uses the project typescript from the nearest node_modules above the file before any env pin', async () => {
    const repo = initRepo(sb, 'r-local-ts');
    const pkg = join(repo.root, 'node_modules', 'typescript');
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version: '0.0.0-test', main: 'lib/typescript.js' }));
    symlinkSync(TS_PATH, join(pkg, 'lib', 'typescript.js'));
    repo.write('src/g.ts', BASE); repo.commitAll();
    repo.write('src/g.ts', BASE.replace('  return 1;', '  // кириллица\n  return 1;'));
    const r = await checker.run(changed(repo, 'src/g.ts'), ctx(sb, {}));
    assert.equal(r.verdict, 'fail', r.missing_reason);
    assert.equal(dirname(TS_PATH).length > 0, true);
  });

  it('answers unknown for a file outside any git repository — added lines cannot be isolated', async () => {
    const dir = join(sb.dir, 'nogit'); mkdirSync(dir, { recursive: true });
    const abs = join(dir, 'h.ts'); writeFileSync(abs, '// кириллица\nexport const z = 1;\n');
    const r = await checker.run({ repo: dir, path: 'h.ts', absPath: abs, digest: '0', status: 'M' }, ctx(sb));
    assert.equal(r.verdict, 'unknown');
    assert.match(r.missing_reason ?? '', /git/i);
  });

  it('answers unknown, not pass, when the file does not parse — comment ranges of a broken tree are not evidence', async () => {
    const repo = initRepo(sb, 'r-broken');
    repo.write('src/i.ts', BASE); repo.commitAll();
    repo.write('src/i.ts', BASE + 'export function (\n');
    const r = await checker.run(changed(repo, 'src/i.ts'), ctx(sb));
    assert.equal(r.verdict, 'unknown');
  });
});
