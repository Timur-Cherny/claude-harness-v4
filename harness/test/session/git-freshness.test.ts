// Молча ломалось (24.08): трекер прочитан на коммит позади — правило «стянуть перед чтением» жило в памяти.
// Ложное срабатывание опаснее молчания: свой коммит внутри хода кричал как чужой, пока не появилась печать (seal).
// INVARIANT: чужой сдвиг HEAD между ходами — доложен; свой сдвиг внутри хода — нет; отставание от upstream
// докладывается один раз на изменение; fetch не чаще 600 с и не в этом процессе; явный путь без git → unknown.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { initRepo, commit, headShort, sh } from './_git.ts';
import { decide, runFetch, resolveRepos, resolveRoots, FETCH_EVERY_MS, KILL, NAME } from '../../src/session/git-freshness.ts';
import { State } from '../../src/state.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent } from '../../src/types.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

type Sb = ReturnType<typeof sandbox>;
// toplevel() отдаёт физический путь (macOS: /var → /private/var) — фикстуры сравниваются в той же форме.
const real = (p: string) => realpathSync(p);
function ctxFor(sb: Sb, event: HarnessEvent, env: Record<string, string>, now: number): GateContext {
  const hook = event === 'stop' ? 'Stop' : 'UserPromptSubmit';
  return { event, payload: payload(hook, { prompt: 'x' }, sb.dir) as never, env: { HOME: sb.home, ...env }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => now };
}
function rows(sb: Sb): Array<{ repo: string; head_seen: string | null; behind: string; behind_said: string; fetch_started_at: number }> {
  const st = State.open(sb.stateDir);
  try {
    const has = st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='git_freshness'").get();
    return has ? st.db.prepare('SELECT repo, head_seen, behind, behind_said, fetch_started_at FROM git_freshness ORDER BY repo').all() as never : [];
  } finally { st.close(); }
}
function setBehind(sb: Sb, repo: string, text: string): void {
  const st = State.open(sb.stateDir);
  try { st.db.prepare('UPDATE git_freshness SET behind = ? WHERE repo = ?').run(text, repo); } finally { st.close(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(NAME, () => {
  const sb = sandbox('harness-freshness-');
  after(() => sb.cleanup());
  const engine = real(initRepo(join(sb.dir, 'engine'))); commit(engine, 'a.txt', '1\n', 'first engine commit');
  const vaultRepo = real(initRepo(join(sb.dir, 'vault-repo'))); commit(vaultRepo, 'README.md', 'v\n');
  const vault = join(vaultRepo, 'docs', 'vault'); mkdirSync(join(vault, 'work-docs'), { recursive: true });
  const tracker = join(vault, 'work-docs', 'TRACKER_WMS.md'); writeFileSync(tracker, '# tracker\n'); utimesSync(tracker, 1_700_000_000, 1_700_000_000);
  const env = { WMS_ENGINE: engine, WMS_VAULT: vault };
  const spawned: string[] = [];
  const stub = (root: string) => { spawned.push(root); };
  let now = 1_800_000_000_000;

  it('stays silent on the first prompt, records HEAD per repo root (vault subdir resolves to its repo) and starts one fetch each', () => {
    const v = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(v.kind, 'silent');
    const r = rows(sb);
    assert.deepEqual(r.map((x) => x.repo).sort(), [engine, vaultRepo].sort());
    assert.equal(r.find((x) => x.repo === engine)?.head_seen, headShort(engine));
    assert.deepEqual([...spawned].sort(), [engine, vaultRepo].sort());
  });

  it('reports a HEAD moved between prompts by someone else with old → new and the top subject, then falls quiet', () => {
    const was = headShort(engine);
    commit(engine, 'b.txt', '2\n', 'foreign session commit');
    now += 1000;
    const v = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(v.kind, 'context');
    const text = (v as { text: string }).text;
    assert.match(text, /СВЕЖЕСТЬ ЧЕКАУТОВ/);
    assert.match(text, new RegExp(`engine: HEAD сдвинулся ${was} → ${headShort(engine)}`));
    assert.match(text, /Верх: foreign session commit/);
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
  });

  it('does not report my own commit when the stop-seal ran after it — the seal is what keeps the alarm honest', () => {
    commit(engine, 'c.txt', '3\n', 'my own commit inside the turn');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'stop', env, now)).kind, 'silent');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
  });

  it('throttles the background fetch: none within 600 s of the last start, one more after it', () => {
    spawned.length = 0;
    now += 1000;
    decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.deepEqual(spawned, []);
    now += FETCH_EVERY_MS;
    decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.deepEqual([...spawned].sort(), [engine, vaultRepo].sort());
  });

  it('reports "behind upstream" exactly once per change, resets when the lag clears and speaks again on a new lag', () => {
    setBehind(sb, engine, 'позади origin/main на 2 коммит(ов) — стянуть до чтения');
    now += 1000;
    const first = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(first.kind, 'context');
    assert.match((first as { text: string }).text, /engine: позади origin\/main на 2/);
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent', 'повтор того же отставания — шум');
    setBehind(sb, engine, '');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
    assert.equal(rows(sb).find((x) => x.repo === engine)?.behind_said, '');
    setBehind(sb, engine, 'позади origin/main на 5 коммит(ов) — стянуть до чтения');
    now += 1000;
    assert.match((decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }) as { text: string }).text, /на 5/);
  });

  it('reports an uncommitted change of TRACKER_WMS.md since the last prompt and is quiet after the seal', () => {
    utimesSync(tracker, 1_700_000_500, 1_700_000_500);
    now += 1000;
    const v = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /TRACKER_WMS\.md изменён/);
    utimesSync(tracker, 1_700_000_900, 1_700_000_900);
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'stop', env, now)).kind, 'silent');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
  });

  it('answers unknown naming the variable when an explicit path is not a git repository; an unset variable is skipped silently', () => {
    const sb2 = sandbox('harness-freshness-unknown-');
    const plain = join(sb2.dir, 'plain'); mkdirSync(plain);
    const v = decide(ctxFor(sb2, 'prompt', { WMS_ENGINE: plain, WMS_VAULT: join(sb2.dir, 'gone') }, now), { spawnFetch: stub });
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /WMS_ENGINE: каталог исчез или не git/);
    assert.match((v as { reason: string }).reason, /WMS_VAULT/);
    // Ничего не задано, дефолтного вольта нет — не о чем говорить.
    assert.equal(decide(ctxFor(sb2, 'prompt', {}, now), { spawnFetch: stub }).kind, 'silent');
    sb2.cleanup();
  });

  it('visits a repository once even when two variables point into it, and reads paths from wms-paths.sh when env is empty', () => {
    const sb3 = sandbox('harness-freshness-dedup-');
    const repo = real(initRepo(join(sb3.dir, 'one'))); commit(repo, 'a', '1\n');
    const sub = join(repo, 'packages', 'x'); mkdirSync(sub, { recursive: true });
    const r = resolveRoots({ HOME: sb3.home, WMS_FE: repo, WMS_CONN: sub });
    assert.deepEqual(r.roots, [repo]);
    assert.deepEqual(r.problems, []);
    mkdirSync(join(sb3.home, '.claude', 'env'), { recursive: true });
    writeFileSync(join(sb3.home, '.claude', 'env', 'wms-paths.sh'), `export WMS_VAULT="${sb3.dir}/vault"\nexport WMS_ENGINE="${repo}"\n`);
    const spec = resolveRepos({ HOME: sb3.home });
    assert.deepEqual(spec.specs.map((s) => [s.source, s.path, s.explicit]), [['WMS_VAULT', `${sb3.dir}/vault`, true], ['WMS_ENGINE', repo, true]]);
    sb3.cleanup();
  });

  it('runFetch records the lag behind upstream after a real fetch from a local origin, and clears it when caught up', () => {
    const sb4 = sandbox('harness-freshness-fetch-');
    const origin = initRepo(join(sb4.dir, 'origin')); commit(origin, 'a', '1\n');
    const local = join(sb4.dir, 'local');
    sh(sb4.dir, 'git', ['clone', '-q', origin, local]);
    commit(origin, 'b', '2\n', 'upstream moved');
    assert.match(runFetch(local, sb4.stateDir), /позади origin\/main на 1 коммит\(ов\)/);
    assert.match(rows(sb4)[0].behind, /на 1/);
    sh(local, 'git', ['merge', '-q', '--ff-only', 'origin/main']);
    assert.equal(runFetch(local, sb4.stateDir), '');
    assert.equal(rows(sb4)[0].behind, '');
    sb4.cleanup();
  });

  it('starts the real detached fetch child on prompt and the lag appears in state without the hook waiting for it', async () => {
    const sb5 = sandbox('harness-freshness-detached-');
    const origin = initRepo(join(sb5.dir, 'origin')); commit(origin, 'a', '1\n');
    const local = join(sb5.dir, 'local'); sh(sb5.dir, 'git', ['clone', '-q', origin, local]);
    const localReal = real(local);
    commit(origin, 'b', '2\n');
    const t0 = Date.now();
    assert.equal(decide(ctxFor(sb5, 'prompt', { WMS_ENGINE: local, WMS_VAULT: join(sb5.dir, 'none') }, Date.now())).kind, 'unknown', 'вольт задан явно и отсутствует');
    assert.ok(Date.now() - t0 < 5000, 'хук ждал fetch');
    let behind = '';
    for (let i = 0; i < 100 && !behind; i++) { await sleep(150); behind = rows(sb5).find((x) => x.repo === localReal)?.behind ?? ''; }
    assert.match(behind, /позади origin\/main на 1/);
    sb5.cleanup();
  });

  it('is skipped by its kill-switch through route(): silent and no freshness state written', async () => {
    const sb6 = sandbox('harness-freshness-kill-');
    const v = await route('prompt', payload('UserPromptSubmit', { prompt: 'x' }, engine) as never, { HOME: sb6.home, CLAUDE_STATE_DIR: sb6.stateDir, HARNESS_ROOT, WMS_ENGINE: engine, [KILL]: '1' });
    assert.equal(v.kind, 'silent');
    assert.deepEqual(rows(sb6), []);
    assert.equal(existsSync(join(sb6.stateDir, 'harness.db')) && (() => { const st = State.open(sb6.stateDir); try { return st.marker('git-freshness:tracker.mtime') !== null; } finally { st.close(); } })(), false);
    sb6.cleanup();
  });
});
