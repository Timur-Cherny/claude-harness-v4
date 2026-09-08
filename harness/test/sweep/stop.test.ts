// INVARIANT I1: Stop не проходит молча, пока фоновые проверки не дренированы; unknown воркера доставляется,
// а не теряется; второй Stop с той же подписью не запирает сессию (один блок на подпись), кроме pending.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../src/main.ts';
import { sweep } from '../../src/sweep.ts';
import { State } from '../../src/state.ts';
import { sandbox, payload, HARNESS_ROOT, onlyGate } from '../_env.ts';

function git(cwd: string, ...args: string[]): void { execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); }

describe('sweep on Stop', () => {
  const sb = sandbox();
  const repo = join(sb.dir, 'repo');
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: '/usr/bin:/bin', ...onlyGate('sweep-stop') }; // без npx/tsc в PATH → worker-ярус даёт unknown
  after(() => sb.cleanup());

  it('drains a worker-tier job synchronously and blocks once with the unknown it produced, then degrades to context', async () => {
    mkdirSync(repo); git(repo, 'init', '-q');
    writeFileSync(join(repo, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}'); writeFileSync(join(repo, 'a.ts'), 'export const a: number = 1;\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'i');
    writeFileSync(join(repo, 'a.ts'), 'export const a: number = "x";\n');
    const st = State.open(sb.stateDir);
    const ctx = { event: 'post' as const, payload: payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1' }, repo) as never, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
    const out = await sweep(ctx, st, { spawnWorker: false });
    assert.equal(out.pending, 1, 'tsc-задача не поставлена в очередь');
    st.close();
    const stop1 = await route('stop', payload('Stop', {}, repo) as never, env);
    assert.equal(stop1.kind, 'block');
    assert.match((stop1 as { reason: string }).reason, /a\.ts \[tsc-project\] unknown: tsc не установлен/);
    const stop2 = await route('stop', payload('Stop', {}, repo) as never, env);
    assert.equal(stop2.kind, 'silent', 'находка уже доставлена этой сессии и подпись заблокирована один раз — второй Stop не запирает сессию');
  });

  it('is silent on Stop when the tree is clean', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export const a: number = 1;\n');
    const v = await route('stop', payload('Stop', { session_id: 'session-clean' }, repo) as never, env);
    assert.equal(v.kind, 'silent');
  });
});
