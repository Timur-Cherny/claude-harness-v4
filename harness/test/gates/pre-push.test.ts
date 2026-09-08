// Молча ломалось: push в product/main с фичевой ветки, MR фичевой в main (!115/!116), серия с обвязкой стенда
// (chore(env), 25.08); плюс два незакрытых класса из матрицы покрытия — одна миграция под двумя штампами после
// мержа (CHIP_connector-migration-collision) и release/<N+1>, срезанный при незамкнутом в main хотфиксе
// (INC-GETORCREATE-FIX-NOT-ON-MAIN). Гейт спрашивает git о серии и refs, а не разбирает текст.
// INVARIANT: push/MR в защищённую ветку только с release/*|hotfix/*; серия наружу без локальной обвязки;
// H1 — новая миграция ветки не совпадает телом с миграцией таргета под другим штампом и не несёт штамп «…00000»;
// H2 — перед release/<N+1> вершины remote release/<меньше> и hotfix/* — предки remote product/main.
// Нет данных (цель push не разобрана, detached HEAD, вне git, remote без refs, нет remote/product/main) → unknown.
// REGRESSION: bash-оригинал пропускал неразобранную цель с предупреждением; `cd X && git push` и `git -C X push`
// зависели от префикса матчера settings.json, не подтверждённого пробой.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sandbox, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/gates/pre-push.ts';
import { resetConfigCache } from '../../src/config.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox();
after(() => sb.cleanup());
const remote = join(sb.dir, 'remote.git');
const repo = join(sb.dir, 'repo');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(files: Record<string, string>, subject: string): void {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(repo, dirname(p)), { recursive: true }); writeFileSync(join(repo, p), c); }
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', subject);
}
function run(command: string, branch: string | null, env: NodeJS.ProcessEnv = {}, cwd = repo): Verdict {
  if (branch) g(repo, 'checkout', '-q', branch);
  const payload = bashPayload(command) as unknown as HookPayload;
  (payload as { cwd: string }).cwd = cwd;
  // Защищённая ветка — свойство площадки: фикстуры корпуса живут на product/main, поэтому корпус задаёт её
  // явно через env. Дженерик-дефолт (main) проверяется отдельным кейсом ниже, без env и без конфига.
  const ctx: GateContext = { event: 'pre-bash', payload, env: { PREPUSH_PROTECTED: 'product/main', ...env }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
  return decide(ctx);
}
const reason = (v: Verdict): string => (v as { reason?: string }).reason ?? '';
const migration = (stamp: string, cls: string, table: string): string =>
  `import { MigrationInterface, QueryRunner } from 'typeorm';\n\nexport class ${cls}${stamp} implements MigrationInterface {\n  name = '${cls}${stamp}';\n  async up(q: QueryRunner): Promise<void> { await q.query('CREATE TABLE ${table}(id int)'); }\n  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE ${table}'); }\n}\n`;

before(() => {
  g(sb.dir, 'init', '-q', '--bare', remote);
  g(sb.dir, 'init', '-q', repo);
  g(repo, 'remote', 'add', 'origin', remote);
  commit({ 'src/app.ts': 'export const a = 1;\n' }, 'feat: base');
  g(repo, 'branch', '-M', 'product/main');
  g(repo, 'push', '-q', 'origin', 'product/main');
  g(repo, 'checkout', '-q', '-b', 'product/dev'); g(repo, 'push', '-q', 'origin', 'product/dev');
  g(repo, 'checkout', '-q', '-b', 'feature/js-1', 'product/main'); commit({ 'src/feat.ts': 'export const b = 2;\n' }, 'feat: work');
  g(repo, 'checkout', '-q', '-b', 'release/1.45.3', 'product/main'); commit({ 'src/rel.ts': 'export const c = 3;\n' }, 'feat: release content');
  g(repo, 'checkout', '-q', '-b', 'hotfix/js-2', 'product/main'); commit({ 'src/hot.ts': 'export const d = 4;\n' }, 'fix: hotfix');
  g(repo, 'checkout', '-q', '-b', 'feature/js-3', 'product/main'); commit({ 'src/ok.ts': 'export const e = 5;\n' }, 'feat: clean work');
  commit({ 'env/.env.stand': 'API=http://127.0.0.1:8080\n' }, 'chore(env): стенд');
});

describe(NAME, () => {
  describe('bash corpus (pre-push-guard.test.sh 1-13)', () => {
    it('1. feature branch → push to product/main is denied', () => {
      const v = run('git push origin HEAD:product/main', 'feature/js-1');
      assert.equal(v.kind, 'deny', reason(v)); assert.match(reason(v), /только с release\/\* или hotfix\/\*/);
    });
    it('2. release/* → product/main passes (I7: a wall gets switched off)', () => { assert.equal(run('git push origin HEAD:product/main', 'release/1.45.3').kind, 'silent'); });
    it('3. hotfix/* → product/main passes', () => { assert.equal(run('git push origin HEAD:product/main', 'hotfix/js-2').kind, 'silent'); });
    it('4. feature → product/dev passes', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/js-1').kind, 'silent'); });
    it('5. explicit branch name in the refspec is denied', () => { assert.equal(run('git push origin feature/js-1:product/main', 'feature/js-1').kind, 'deny'); });
    it('6. `-u remote branch` form is denied', () => { assert.equal(run('git push -u origin product/main', 'feature/js-1').kind, 'deny'); });
    it('7. MR from a feature branch into product/main is denied', () => {
      const v = run('glab mr create --target-branch product/main --title x', 'feature/js-1');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /MR в product\/main/);
    });
    it('8. MR from a feature branch into product/dev passes', () => { assert.equal(run('glab mr create --target-branch product/dev --title x', 'feature/js-1').kind, 'silent'); });
    it('9. MR from release/* into product/main passes', () => { assert.equal(run('glab mr create --target-branch=product/main --title rel', 'release/1.45.3').kind, 'silent'); });
    it('10. a series carrying chore(env) is denied with the offending commit', () => {
      const v = run('git push origin HEAD:product/dev', 'feature/js-3');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /chore\(env\): стенд/); assert.match(reason(v), /rebase --onto origin\/product\/dev/);
    });
    it('11. a clean series passes', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/js-1').kind, 'silent'); });
    it('12. `git push` without a target and without upstream → unknown (bash warned and passed; unknown never collapses to silent)', () => {
      const v = run('git push', 'feature/js-1');
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /upstream/);
    });
    it('13. a non-git command passes instantly', () => { assert.equal(run('npm run build', 'feature/js-1').kind, 'silent'); });
  });

  describe('new: the push is found by argv and cwd, not by a prefix over the line', () => {
    it('`cd <repo> && git push …` from another cwd is a push in <repo>', () => {
      assert.equal(run(`cd ${repo} && git push origin HEAD:product/main`, 'feature/js-1', {}, '/').kind, 'deny');
    });
    it('`git -C <repo> push …` is a push in <repo>', () => {
      assert.equal(run(`git -C ${repo} push origin HEAD:product/main`, 'feature/js-1', {}, '/').kind, 'deny');
      assert.equal(run(`git -C ${repo} push origin HEAD:product/dev`, 'feature/js-1', {}, '/').kind, 'silent');
    });
    it('a push after `;` and inside `sh -c` is still seen', () => {
      assert.equal(run('echo x; git push origin HEAD:product/main', 'feature/js-1').kind, 'deny');
      assert.equal(run(`sh -c "git push origin HEAD:product/main"`, 'feature/js-1').kind, 'deny');
    });
    it('`git push origin` and bare `git push` resolve the target through the configured upstream', () => {
      g(repo, 'checkout', '-q', 'feature/js-1'); g(repo, 'branch', '-u', 'origin/product/main');
      try {
        assert.equal(run('git push origin', null).kind, 'deny');
        assert.equal(run('git push', null).kind, 'deny');
        g(repo, 'branch', '-u', 'origin/product/dev');
        assert.equal(run('git push', null).kind, 'silent');
      } finally { g(repo, 'branch', '--unset-upstream'); }
    });
    it('a target given through a variable is expanded from env; unset → unknown; $(…) → unknown', () => {
      assert.equal(run('git push origin HEAD:$TARGET', 'feature/js-1', { TARGET: 'product/main' }).kind, 'deny');
      assert.equal(run('git push origin HEAD:$TARGET', 'feature/js-1', {}).kind, 'unknown');
      assert.equal(run('git push origin HEAD:$(git branch --show-current)', 'feature/js-1').kind, 'unknown');
    });
    it('cwd outside any git repository → unknown, not a pass', () => {
      const v = run('git push origin HEAD:product/main', 'feature/js-1', {}, sb.dir);
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /вне git/);
    });
    it('detached HEAD → unknown: the source branch is not determined', () => {
      g(repo, 'checkout', '-q', '--detach', 'feature/js-1');
      try { const v = run('git push origin HEAD:product/main', null); assert.equal(v.kind, 'unknown'); assert.match(reason(v), /detached/); }
      finally { g(repo, 'checkout', '-q', 'feature/js-1'); }
    });
    it('PREPUSH_PROTECTED widens the protected set', () => {
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-1', { PREPUSH_PROTECTED: 'product/main,product/dev' }).kind, 'deny');
    });
  });

  describe('H1: migration bodies against the target branch', () => {
    before(() => {
      g(repo, 'checkout', '-q', 'product/dev');
      commit({ 'src/migration/1700000000001-add-users.ts': migration('1700000000001', 'AddUsers', 'users') }, 'feat: users migration');
      g(repo, 'push', '-q', 'origin', 'product/dev');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-dup', 'product/dev~1');
      commit({ 'src/migration/1700000000777-add-users-again.ts': migration('1700000000777', 'AddUsers', 'users') }, 'feat: users migration again');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-same', 'product/dev~1');
      commit({ 'src/migration/1700000000001-add-users.ts': migration('1700000000001', 'AddUsers', 'users') }, 'feat: same migration same name');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-round', 'product/dev');
      commit({ 'src/migration/1700000100000-add-orders.ts': migration('1700000100000', 'AddOrders', 'orders') }, 'feat: orders migration');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-ok', 'product/dev');
      commit({ 'src/migration/1700000000555-add-orders.ts': migration('1700000000555', 'AddOrders', 'orders') }, 'feat: orders migration');
    });
    it('the same body under another stamp → deny naming both files', () => {
      const v = run('git push origin HEAD:product/dev', 'feature/mig-dup');
      assert.equal(v.kind, 'deny', reason(v));
      assert.match(reason(v), /1700000000777-add-users-again\.ts/); assert.match(reason(v), /1700000000001-add-users\.ts/);
    });
    it('the same rule guards `glab mr create` into that target', () => {
      assert.equal(run('glab mr create --target-branch product/dev --title x', 'feature/mig-dup').kind, 'deny');
    });
    it('a stamp ending in 00000 → deny naming the stamp', () => {
      const v = run('git push origin HEAD:product/dev', 'feature/mig-round');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /круглый штамп 1700000100000/);
    });
    it('the same body under the same name is not a new migration → pass', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/mig-same').kind, 'silent'); });
    it('a genuinely new migration → pass', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/mig-ok').kind, 'silent'); });
    it('first push of a new branch has no target to collide with → pass', () => { assert.equal(run('git push -u origin feature/mig-dup', 'feature/mig-dup').kind, 'silent'); });
    it('a remote with no local refs → unknown (fetch first), never a pass', () => {
      const empty = join(sb.dir, 'empty.git'); g(sb.dir, 'init', '-q', '--bare', empty); g(repo, 'remote', 'add', 'empty', empty);
      const v = run('git push empty HEAD:product/dev', 'feature/mig-dup');
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /нет локальных refs/);
    });
  });

  describe('H2: release/hotfix closure into main before release/<N+1>', () => {
    before(() => {
      g(repo, 'push', '-q', 'origin', 'release/1.45.3', 'hotfix/js-2');
      g(repo, 'branch', 'release/1.46.0', 'product/main');
      g(repo, 'branch', 'release/1.40.0', 'product/main');
    });
    it('release/1.46.0 while origin/release/1.45.3 and origin/hotfix/js-2 tips are not in origin/product/main → deny naming the tips', () => {
      const v = run('git push -u origin release/1.46.0', 'release/1.46.0');
      assert.equal(v.kind, 'deny', reason(v));
      assert.match(reason(v), /release\/1\.45\.3 \([0-9a-f]{9}\)/); assert.match(reason(v), /hotfix\/js-2 \([0-9a-f]{9}\)/);
    });
    it('only releases with a smaller number count: release/1.40.0 is stopped by the hotfix, not by release/1.45.3', () => {
      const v = run('git push -u origin release/1.40.0', 'release/1.40.0');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /hotfix\/js-2/); assert.doesNotMatch(reason(v), /release\/1\.45\.3/);
    });
    it('a remote without product/main → unknown', () => {
      const nomain = join(sb.dir, 'nomain.git'); g(sb.dir, 'init', '-q', '--bare', nomain); g(repo, 'remote', 'add', 'nomain', nomain);
      g(repo, 'push', '-q', 'nomain', 'release/1.45.3');
      const v = run('git push nomain release/1.46.0', 'release/1.46.0');
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /product\/main/);
    });
    it('after the release and the hotfix are merged into origin/product/main the same push passes', () => {
      g(repo, 'checkout', '-q', 'product/main');
      g(repo, 'merge', '-q', '--no-edit', 'release/1.45.3'); g(repo, 'merge', '-q', '--no-edit', 'hotfix/js-2');
      g(repo, 'push', '-q', 'origin', 'product/main');
      assert.equal(run('git push -u origin release/1.46.0', 'release/1.46.0').kind, 'silent');
    });
  });

  describe('through the router', () => {
    const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PREPUSH_PROTECTED: 'product/main' };
    const payload = (): HookPayload => { const p = bashPayload('git push origin HEAD:product/main') as unknown as HookPayload; (p as { cwd: string }).cwd = repo; return p; };
    it('kill-switch CLAUDE_SKIP_PREPUSH_GUARD=1 → silent and nothing written to state or journals', async () => {
      g(repo, 'checkout', '-q', 'feature/js-1');
      const v = await route('pre-bash', payload(), { ...env, CLAUDE_SKIP_PREPUSH_GUARD: '1' });
      assert.equal(v.kind, 'silent');
      assert.deepEqual(readdirSync(sb.stateDir), []); assert.deepEqual(readdirSync(sb.home), []);
    });
    it('without the switch the same payload is denied with the gate name', async () => {
      const v = await route('pre-bash', payload(), env);
      assert.equal(v.kind, 'deny'); assert.equal((v as { gate: string }).gate, NAME);
    });
    it('unknown (no upstream) becomes ask on the pre-event', async () => {
      const p = bashPayload('git push') as unknown as HookPayload; (p as { cwd: string }).cwd = repo;
      assert.equal((await route('pre-bash', p, env)).kind, 'ask');
    });
  });

  // Переносимость: свежая установка обязана иметь защищённую ветку БЕЗ настройки, иначе первый же push
  // в main на новой машине проходит молча. Дефолт — main; product/main задаётся конфигом площадки.
  describe('generic default with neither env nor config', () => {
    const noConfig = { PREPUSH_PROTECTED: undefined, HOME: sb.home };
    it('denies a direct push to main from a feature branch out of the box', () => {
      resetConfigCache();
      const v = run('git push origin HEAD:main', 'feature/js-1', noConfig);
      assert.equal(v.kind, 'deny', 'на свежей машине main обязан быть защищён без конфига');
    });
    it('does not deny the same push from a release branch — the rule is the source, not the word main', () => {
      resetConfigCache();
      assert.notEqual(run('git push origin HEAD:main', 'release/1.45.3', noConfig).kind, 'deny');
    });
    it('leaves product/main unprotected until the site config names it', () => {
      resetConfigCache();
      assert.notEqual(run('git push origin HEAD:product/main', 'feature/js-1', noConfig).kind, 'deny');
    });
  });
});
