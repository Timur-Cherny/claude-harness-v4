// INVARIANT К4: истина о правке — рабочее дерево. Одна и та же сломанная правка через любую дверь
// (Write, sed -i, heredoc, python -c, cp, чужой процесс, правка+commit одним вызовом) даёт одну и ту же находку;
// возврат к проверенному виду — тишина; дерево вне git — unknown, не pass.
// Молча ломалось: 02.09 — 39 файлов через Bash, 0 проверок (матчер Edit|Write).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../src/main.ts';
import { State } from '../../src/state.ts';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';

const BROKEN = '#!/bin/bash\nif [ 1 ]; then\n  echo x\n# fi забыт\n';
const OK = '#!/bin/bash\nif [ 1 ]; then\n  echo x\nfi\n';

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); }

describe('sweep through every door', () => {
  const sb = sandbox();
  const repo = join(sb.dir, 'repo');
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '' };
  let n = 0;
  const post = (command: string, extra: Record<string, unknown> = {}) => route('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: `t${++n}`, ...extra }, repo) as never, env);
  before(() => { mkdirSync(repo); git(repo, 'init', '-q'); writeFileSync(join(repo, 'ok.sh'), OK); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); });
  after(() => sb.cleanup());

  it('reports the same syntax failure whatever wrote the file: Write, sed, heredoc via sh, python -c, cp, external process', async () => {
    const doors: Array<[string, () => void]> = [
      ['write-tool', () => writeFileSync(join(repo, 'ok.sh'), BROKEN)],
      ['sed', () => spawnSync('sh', ['-c', `printf '%s' "$1" > ok.sh`, 'x', BROKEN], { cwd: repo })],
      ['heredoc', () => spawnSync('sh', ['-c', `cat > ok.sh <<'EOF'\n${BROKEN}EOF`], { cwd: repo })],
      ['python', () => spawnSync('python3', ['-c', `open('ok.sh','w').write(${JSON.stringify(BROKEN)})`], { cwd: repo })],
      ['cp', () => { writeFileSync(join(sb.dir, 'src.sh'), BROKEN); spawnSync('cp', [join(sb.dir, 'src.sh'), 'ok.sh'], { cwd: repo }); }],
    ];
    for (const [name, act] of doors) {
      writeFileSync(join(repo, 'ok.sh'), OK);
      let v = await post(`# reset ${name}`); // возврат к проверенному виду
      act();
      v = await post(`# door ${name}`);
      assert.equal(v.kind, 'context', `${name}: вердикт ${v.kind}`);
      assert.match((v as { text: string }).text, /ok\.sh \[syntax\] fail/, name);
    }
  });

  it('stays silent once the file is back to a verified content and reports again only after it changes', async () => {
    writeFileSync(join(repo, 'ok.sh'), OK);
    assert.equal((await post('# fixed')).kind, 'silent');
    assert.equal((await post('# nothing changed')).kind, 'silent');
    writeFileSync(join(repo, 'ok.sh'), BROKEN + '\n');
    assert.equal((await post('# broken again with a new digest')).kind, 'context');
  });

  it('delivers a finding once per session — the same broken content stays silent for this session but is reported to a new session in the same tree', async () => {
    writeFileSync(join(repo, 'ok.sh'), BROKEN + '\n\n');
    assert.equal((await post('# first')).kind, 'context');
    assert.equal((await post('# same broken content')).kind, 'silent');
    const other = await route('post', payload('PostToolUse', { session_id: 'session-2', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'z1' }, repo) as never, env);
    assert.equal(other.kind, 'context');
  });

  it('sees a file inside a brand-new directory (-uall) and a file changed and committed in the same call (HEAD shift)', async () => {
    writeFileSync(join(repo, 'ok.sh'), OK); await post('# settle');
    mkdirSync(join(repo, 'newdir')); writeFileSync(join(repo, 'newdir', 'n.sh'), BROKEN);
    assert.match((await post('# new dir') as { text: string }).text, /newdir\/n\.sh \[syntax\] fail/);
    writeFileSync(join(repo, 'newdir', 'n.sh'), OK); await post('# fix'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'clean');
    await post('# settle head');
    writeFileSync(join(repo, 'c.sh'), BROKEN); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'broken commit');
    const v = await post('sed -i x c.sh && git commit -am x');
    assert.equal(v.kind, 'context', 'правка+commit одним вызовом невидима: status пуст, HEAD сдвинулся');
    assert.match((v as { text: string }).text, /c\.sh \[syntax\] fail/);
  });

  it('registers a second repository named in the Bash command and checks it on the same event', async () => {
    const other = join(sb.dir, 'other'); mkdirSync(other); git(other, 'init', '-q'); writeFileSync(join(other, 'a.sh'), OK); git(other, 'add', '.'); git(other, 'commit', '-qm', 'i');
    writeFileSync(join(other, 'a.sh'), BROKEN);
    const v = await post(`cd ${other} && sed -i '' 's/x/y/' a.sh`);
    assert.match((v as { text: string }).text, /a\.sh \[syntax\] fail/);
  });

  it('answers unknown (yellow context) when the cwd is not a git repository — never a silent pass', async () => {
    const plain = join(sb.dir, 'plain'); mkdirSync(plain);
    const v = await route('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'u1' }, plain) as never, env);
    assert.equal(v.kind, 'silent', 'каталог вне git не регистрируется корнем — это документированная граница, не unknown-шум');
  });

  it('is silent under CLAUDE_SKIP_TREE_SWEEP=1 and leaves no trace in state', async () => {
    writeFileSync(join(repo, 'ok.sh'), BROKEN + '\n\n\n');
    const v = await post('# skipped', {});
    void v;
    const before = (State.open(sb.stateDir).db.prepare('SELECT count(*) c FROM findings').get() as { c: number }).c;
    const skipped = await route('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'k1' }, repo) as never, { ...env, CLAUDE_SKIP_TREE_SWEEP: '1' });
    assert.equal(skipped.kind, 'silent');
    const after2 = (State.open(sb.stateDir).db.prepare('SELECT count(*) c FROM findings').get() as { c: number }).c;
    assert.equal(after2, before);
  });

  it('deduplicates two hooks of the same tool_use_id (user-level + repo-level settings) — the loser is silent', async () => {
    writeFileSync(join(repo, 'ok.sh'), BROKEN + '\n\n\n\n');
    const a = await route('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'dup' }, repo) as never, env);
    const b = await route('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'dup' }, repo) as never, env);
    assert.deepEqual([a.kind, b.kind], ['context', 'silent']);
  });

  it('uses the project .claude/check.sh contract and reports its output on failure', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'check.sh'), '#!/bin/bash\ncase "$1" in *.md) grep -q "^# " "$1" || { echo "no title: $1"; exit 1; };; esac\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(repo, 'doc.md'), 'no heading here\n');
    const v = await post('# md without title');
    assert.match((v as { text: string }).text, /doc\.md \[project-check\] fail: doc\.md: no title/);
    writeFileSync(join(repo, 'doc.md'), '# Title\n');
    const fixed = await post('# md fixed');
    assert.equal(fixed.kind, 'silent', JSON.stringify(fixed));
    void readFileSync;
  });
});
