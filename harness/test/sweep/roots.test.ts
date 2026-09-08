// INVARIANT: список «каталог упомянут, а не является объектом работы» зависит от того, откуда взят путь.
// REGRESSION: один общий список отсекал и рабочее дерево под /tmp — на linux, где os.tmpdir() и есть /tmp,
// сверка молчала на любой правке (9 красных тестов), а в контейнере CCR не увидела бы вообще ничего.
// Обратная сторона (живой случай 05.09): путь ~/.nvm/versions/node/.../node в аргументе Bash не делает
// репозиторий nvm корнем сессии — до этого теста правило держалось только формулировкой в коде.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../src/main.ts';
import { isToolPath } from '../../src/sweep.ts';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';

const BROKEN = '#!/bin/bash\nif [ 1 ]; then\n  echo x\n# fi забыт\n';

function repoAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  writeFileSync(join(dir, 'ok.sh'), '#!/bin/bash\necho x\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: dir, env });
  return dir;
}

describe('корни сессии', () => {
  const sb = sandbox('harness-roots-');
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '' };
  const cleanup: string[] = [];
  after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); sb.cleanup(); });

  it('sweeps a working tree literally under /tmp when it is the session cwd — a container workspace lives there', async () => {
    const dir = mkdtempSync('/tmp/harness-roots-cwd-');
    cleanup.push(dir);
    const repo = repoAt(join(dir, 'repo'));
    writeFileSync(join(repo, 'ok.sh'), BROKEN);
    const v = await route('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'printf x > ok.sh' }, tool_use_id: 'r1' }, repo) as never, env);
    assert.equal(v.kind, 'context', `вердикт ${v.kind}: дерево под /tmp не попало в сверку`);
    assert.match((v as { text: string }).text, /ok\.sh \[syntax\] fail/);
  });

  it('does not register a repository merely named in a Bash argument inside a version manager, even with changes in it', async () => {
    const nvmish = join(sb.home, '.nvm', 'versions', 'node', 'v24.20.0');
    const repo = repoAt(nvmish);
    writeFileSync(join(repo, 'ok.sh'), BROKEN);
    const work = repoAt(join(sb.dir, 'work'));
    const cmd = `${join(nvmish, 'bin', 'node')} --version`;
    const v = await route('post', payload('PostToolUse', { session_id: 'roots-weak', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'r2' }, work) as never, env);
    assert.equal(v.kind, 'silent', `вердикт ${v.kind}: чужой репозиторий из аргумента команды стал корнем сессии`);
  });

  it('keeps a package directory out even as cwd — an edit inside node_modules is an edit of a foreign artefact', () => {
    assert.equal(isToolPath('/srv/app/node_modules/lib/index.js', 'strong'), true);
    assert.equal(isToolPath('/srv/app/src/index.ts', 'strong'), false);
  });

  it('separates the two lists: a system path or the own config is dropped only when it comes from a command argument', () => {
    for (const p of ['/usr/local/src/a.ts', '/Library/Caches/x/a.ts', `${process.env.HOME}/.claude/hooks/a.sh`]) {
      assert.equal(isToolPath(p, 'weak'), true, `${p} должен отсекаться как упоминание`);
      assert.equal(isToolPath(p, 'strong'), false, `${p} как место работы отсекаться не должен`);
    }
  });

  it('never drops a temporary path: on linux os.tmpdir() is /tmp, and both the workspace and a second repository named in a command live there', () => {
    for (const p of ['/tmp/work/repo/a.ts', '/private/tmp/work/repo/a.ts']) {
      assert.equal(isToolPath(p, 'weak'), false, `${p}: слабый корень отсекается правилом «только с изменениями», не префиксом`);
      assert.equal(isToolPath(p, 'strong'), false, `${p} как место работы отсекаться не должен`);
    }
  });
});
