// resource-guard: тяжёлая команда при перегрузе ЖДЁТ окна, а не отбивается сразу.
// Молча ломалось (INC-RESOURCE-GUARD-TOKEN-LOOP): мгновенный reject → каждый тест-агент заново
// изобретал «kill-switch + --maxWorkers=1», 51 столкновение за две недели; bash-грепал kill-switch
// по всему тексту команды, так что `echo CLAUDE_SKIP_RESOURCE_GUARD=1 && npx jest` проходил без проверки.
// INVARIANT: лёгкая команда не трогает платформу; тяжёлая при закрытом окне спит ≥ WAIT_S шагом POLL_S и
// только потом deny; окно, открывшееся посреди ожидания, даёт silent; нет сигнала памяти → unknown.
// REGRESSION: ожидание не превышает MAX_WAIT_S (timeout хука 300 с) даже при env выше потолка.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { decide, classify, defaults, NAME, KILL_SWITCH, MAX_WAIT_S } from '../../src/gates/resource.ts';
import { route } from '../../src/main.ts';
import { GATES } from '../../src/gates/registry.ts';
import type { MemorySignal } from '../../src/platform.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';
import { sandbox, bashPayload } from '../_env.ts';

const OPEN: MemorySignal = { available_mb: 6000, constrained_mb: null, load_per_core: 0.4 };
const LOW_MEM: MemorySignal = { available_mb: 900, constrained_mb: null, load_per_core: 0.4 };
const HIGH_LOAD: MemorySignal = { available_mb: 6000, constrained_mb: null, load_per_core: 3.1 };
const NO_SIGNAL: MemorySignal = { available_mb: null, constrained_mb: null, load_per_core: 0.4, missing_reason: 'process.availableMemory недоступен' };

interface Clock { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] }
function fakeClock(): Clock {
  let t = 1_000_000; const slept: number[] = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}

function ctxFor(command: string, env: Record<string, string> = {}, clock?: Clock): GateContext {
  return { event: 'pre-bash', payload: bashPayload(command) as unknown as HookPayload, env, root: '/tmp/none/h', stateDir: '/tmp/none/state', now: clock?.now ?? Date.now };
}

/** Память отдаётся по очереди вызовов; последнее значение повторяется. */
function memorySeq(...sigs: MemorySignal[]): { memory: () => MemorySignal; calls: () => number } {
  let i = 0;
  return { memory: () => { const s = sigs[Math.min(i, sigs.length - 1)]; i++; return s; }, calls: () => i };
}

async function run(command: string, sigs: MemorySignal[], env: Record<string, string> = {}): Promise<{ v: Verdict; clock: Clock; calls: number }> {
  const clock = fakeClock(); const mem = memorySeq(...sigs);
  const v = await decide(ctxFor(command, env, clock), { memory: mem.memory, sleep: clock.sleep, now: clock.now });
  return { v, clock, calls: mem.calls() };
}

const STRICT = { RESOURCE_GUARD_MIN_MB: '99999999', RESOURCE_GUARD_MAX_LOAD: '0.001', RESOURCE_GUARD_WAIT_S: '2', RESOURCE_GUARD_POLL_S: '1' };
const LOOSE = { RESOURCE_GUARD_MIN_MB: '1', RESOURCE_GUARD_MAX_LOAD: '999', RESOURCE_GUARD_WAIT_S: '1', RESOURCE_GUARD_POLL_S: '1' };

describe('resource-guard: bash corpus (hooks/spec/resource-guard-queues.test.sh)', () => {
  it('1. lets a light command through at any thresholds without asking the platform for memory', async () => {
    const r = await run('ls -la', [LOW_MEM], STRICT);
    assert.deepEqual(r.v, { kind: 'silent' });
    assert.equal(r.calls, 0, 'memory() was called for a light command');
    assert.deepEqual(r.clock.slept, []);
  });

  it('2. lets a heavy command through immediately when the window is open', async () => {
    const r = await run('npx jest src/foo.spec.ts', [OPEN], LOOSE);
    assert.deepEqual(r.v, { kind: 'silent' });
    assert.deepEqual(r.clock.slept, []);
    assert.equal(r.calls, 1);
  });

  it('3. waits the full WAIT_S in POLL_S steps before denying a heavy command when the window never opens — queue, not instant reject', async () => {
    const r = await run('npx jest --coverage', [LOW_MEM], STRICT);
    assert.equal(r.v.kind, 'deny');
    assert.deepEqual(r.clock.slept, [1000, 1000], 'two polls of 1 s make up WAIT_S=2');
    assert.equal(r.calls, 3, 'memory is re-read after every sleep');
    const reason = (r.v as { reason: string }).reason;
    assert.match(reason, /ждал окно 2с/);
    assert.match(reason, /память 900MB при пороге 99999999MB/);
    assert.doesNotMatch(reason, /CLAUDE_SKIP|maxWorkers/, 'the denial must not hand out a bypass recipe');
  });

  it('4. kill-switch via route(): silent, gate body never runs, nothing lands in the state dir', async () => {
    const sb = sandbox();
    try {
      const orig = defaults.memory;
      defaults.memory = () => { throw new Error('gate body ran despite kill-switch'); };
      try {
        // Соседние гейты pre-bash гасятся своими выключателями: проверяется поведение ЭТОГО гейта, не их.
        const siblingsOff = Object.fromEntries(GATES.filter((g) => g.events.includes('pre-bash') && g.name !== NAME).map((g) => [g.killSwitch, '1']));
        assert.equal(KILL_SWITCH, 'CLAUDE_SKIP_RESOURCE_GUARD', 'the bash kill-switch name is kept verbatim');
        const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT: '/tmp/none/h', CLAUDE_SKIP_RESOURCE_GUARD: '1', ...STRICT, ...siblingsOff };
        const v = await route('pre-bash', bashPayload('npx jest --coverage') as unknown as HookPayload, env);
        assert.deepEqual(v, { kind: 'silent' });
        assert.deepEqual(readdirSync(sb.stateDir), []);
        // Тот же вызов без выключателя доказывает, что шпион действует: тело исполнилось и упало в unknown → ask.
        const { CLAUDE_SKIP_RESOURCE_GUARD: _omit, ...noKill } = env;
        const asked = await route('pre-bash', bashPayload('npx jest --coverage') as unknown as HookPayload, noKill);
        assert.equal(asked.kind, 'ask');
        assert.match((asked as { reason: string }).reason, /gate body ran/);
      } finally { defaults.memory = orig; }
    } finally { sb.cleanup(); }
  });
});

describe('resource-guard: queue semantics', () => {
  it('goes silent as soon as the window opens mid-wait and stops sleeping', async () => {
    const r = await run('npx vitest run', [LOW_MEM, LOW_MEM, LOW_MEM, OPEN], { RESOURCE_GUARD_WAIT_S: '240', RESOURCE_GUARD_POLL_S: '15' });
    assert.deepEqual(r.v, { kind: 'silent' });
    assert.deepEqual(r.clock.slept, [15000, 15000, 15000]);
    assert.equal(r.calls, 4);
  });

  it('uses the defaults 240 s / 15 s when env is unset: 16 polls, 17 reads, then deny naming 240 s', async () => {
    const r = await run('yarn test', [LOW_MEM]);
    assert.equal(r.v.kind, 'deny');
    assert.equal(r.clock.slept.length, 16);
    assert.ok(r.clock.slept.every((ms) => ms === 15000));
    assert.equal(r.calls, 17);
    assert.match((r.v as { reason: string }).reason, /ждал окно 240с/);
  });

  it('caps the wait at MAX_WAIT_S even when RESOURCE_GUARD_WAIT_S asks for more — the hook must outlive neither its timeout nor the command', async () => {
    const r = await run('npm run build', [LOW_MEM], { RESOURCE_GUARD_WAIT_S: '9999', RESOURCE_GUARD_POLL_S: '60' });
    assert.equal(r.v.kind, 'deny');
    const total = r.clock.slept.reduce((a, b) => a + b, 0);
    assert.equal(total, MAX_WAIT_S * 1000);
  });

  it('denies for load alone and names load, not memory', async () => {
    const r = await run('npx jest', [HIGH_LOAD], { RESOURCE_GUARD_WAIT_S: '1', RESOURCE_GUARD_POLL_S: '1' });
    assert.equal(r.v.kind, 'deny');
    const reason = (r.v as { reason: string }).reason;
    assert.match(reason, /load\/core 3\.10 при пороге 2/);
    assert.doesNotMatch(reason, /память/);
  });

  it('denies for memory alone and names memory, not load', async () => {
    const r = await run('npx jest', [LOW_MEM], { RESOURCE_GUARD_WAIT_S: '1', RESOURCE_GUARD_POLL_S: '1' });
    const reason = (r.v as { reason: string }).reason;
    assert.match(reason, /память 900MB при пороге 2000MB/);
    assert.doesNotMatch(reason, /load/);
  });

  it('answers unknown with the missing_reason when the platform has no memory signal — neither deny nor pass, and no sleeping', async () => {
    const r = await run('npx jest', [NO_SIGNAL], STRICT);
    assert.equal(r.v.kind, 'unknown');
    assert.equal((r.v as { gate: string }).gate, NAME);
    assert.match((r.v as { reason: string }).reason, /availableMemory/);
    assert.deepEqual(r.clock.slept, []);
  });

  it('turns a signal that disappears mid-wait into unknown rather than into a deny built on stale numbers', async () => {
    const r = await run('npx jest', [LOW_MEM, NO_SIGNAL], { RESOURCE_GUARD_WAIT_S: '240' });
    assert.equal(r.v.kind, 'unknown');
    assert.deepEqual(r.clock.slept, [15000]);
  });

  it('falls back to defaults on garbage thresholds instead of treating NaN as open or closed', async () => {
    const r = await run('npx jest', [OPEN], { RESOURCE_GUARD_MIN_MB: 'много', RESOURCE_GUARD_MAX_LOAD: '', RESOURCE_GUARD_WAIT_S: '-5' });
    assert.deepEqual(r.v, { kind: 'silent' });
    const d = await run('npx jest', [LOW_MEM], { RESOURCE_GUARD_MIN_MB: 'много', RESOURCE_GUARD_POLL_S: '0' });
    assert.equal(d.v.kind, 'deny');
    assert.equal(d.clock.slept.length, 240, 'POLL_S=0 is clamped to 1 s, not an infinite loop');
  });

  it('stays silent on payloads with nothing to judge: no command, a non-Bash tool', async () => {
    assert.deepEqual(await decide(ctxFor(''), { memory: () => { throw new Error('touched'); }, sleep: async () => {} }), { kind: 'silent' });
    const p = { ...bashPayload('npx jest'), tool_name: 'Read', tool_input: { file_path: '/x' } } as unknown as HookPayload;
    assert.deepEqual(await decide({ ...ctxFor('x'), payload: p }, { memory: () => { throw new Error('touched'); }, sleep: async () => {} }), { kind: 'silent' });
  });
});

describe('resource-guard: heavy-command recognition by tokenizer, not by substring', () => {
  const heavy: Array<[string, string]> = [
    ['jest', 'npx jest'], ['jest', 'node_modules/.bin/jest --runInBand'], ['jest', 'node --experimental-vm-modules node_modules/jest/bin/jest.js'],
    ['jest', 'yarn jest src/a.spec.ts'], ['jest', 'pnpm exec jest'], ['jest', 'npm exec jest'],
    ['vitest', 'npx vitest run'], ['playwright test', 'npx playwright test e2e/'],
    ['npm test', 'npm test'], ['npm run test:e2e', 'npm run test:e2e'], ['npm run test:integration', 'npm run test:integration -- --ci'],
    ['yarn test', 'yarn test'], ['yarn build', 'yarn build'], ['npm run build', 'npm run build'], ['pnpm run build', 'pnpm run build'],
    ['gradlew', './gradlew assembleDebug'], ['gradle assemblePicking', 'gradle assemblePicking'], ['gradle build', 'gradle build'], ['gradle test', 'gradle test'],
    ['xcodebuild', 'xcodebuild -scheme App'], ['pod install', 'pod install'],
    ['next build', 'next build'], ['vite build', 'npx vite build'], ['webpack', 'npx webpack --mode production'],
    ['tsc -b', 'tsc -b'], ['tsc -b', 'npx tsc --build packages/a'],
    ['docker build', 'docker build -t x .'], ['docker build', 'docker buildx build .'], ['docker compose up', 'docker compose up -d'], ['docker compose up', 'docker-compose up'],
    ['kind create', 'kind create cluster'], ['kind load', 'kind load docker-image x:1'],
    ['emulator -avd', 'emulator -avd Pixel_6'], ['corp-claude', 'corp-claude -p "run tests"'],
    ['jest', 'cd "$WMS_ENGINE" && npx jest --coverage'], ['jest', 'sh -c "npx jest"'], ['jest', 'CI=1 timeout 600 npx jest'],
  ];
  for (const [label, cmd] of heavy) {
    it(`recognises heavy: ${cmd}`, () => assert.equal(classify(cmd).heavy, label));
  }

  const light = [
    'ls -la', 'grep jest README.md', 'cat jest.config.ts', 'echo "npx jest"', 'git log --grep vitest', 'rg playwright docs/',
    'docker ps', 'docker compose ps', 'docker compose down', 'kind get clusters', 'kind delete cluster',
    'tsc --noEmit', 'npx tsc -p tsconfig.json', 'npm run lint', 'npm install', 'yarn add jest', 'npm ci',
    'next dev', 'vite', 'pod update', 'gradle clean', 'npx playwright install', 'emulator -list-avds',
  ];
  for (const cmd of light) {
    it(`treats as light: ${cmd}`, () => assert.deepEqual(classify(cmd), { heavy: null, opaque: [] }));
  }

  it('marks a heavy word hidden in command substitution or backticks as unknown — not silent, not heavy — and does not sleep on it', async () => {
    assert.deepEqual(classify('$(cat run-jest.sh)'), { heavy: null, opaque: ['command-substitution'] });
    const r = await run('`./scripts/run-vitest.sh` && echo done', [OPEN]);
    assert.equal(r.v.kind, 'unknown');
    assert.match((r.v as { reason: string }).reason, /command-substitution/);
    assert.equal(r.calls, 0);
    assert.deepEqual(r.clock.slept, []);
  });

  it('judges a here-doc body line by line — `npx jest` fed to bash through stdin is still heavy', () => {
    assert.equal(classify('bash <<EOF\nnpx jest\nEOF').heavy, 'jest');
  });

  it('does not report opaque parts when no heavy word is anywhere in the command', () => {
    assert.deepEqual(classify('echo $(date)'), { heavy: null, opaque: [] });
  });
});

describe('resource-guard: К1 — inline bypass is a prefix assignment, not a substring', () => {
  it('honours the deliberate one-shot bypass as an env-assignment prefix of the heavy command', async () => {
    const r = await run(`${KILL_SWITCH}=1 npx jest --coverage`, [LOW_MEM], STRICT);
    assert.deepEqual(r.v, { kind: 'silent' });
    assert.equal(r.calls, 0);
  });

  it('does not treat a mere mention of the kill-switch in another argument as a bypass (bash grep let `echo CLAUDE_SKIP_RESOURCE_GUARD=1 && npx jest` through)', async () => {
    const r = await run(`echo ${KILL_SWITCH}=1 && npx jest --coverage`, [LOW_MEM], STRICT);
    assert.equal(r.v.kind, 'deny', `expected the heavy segment to be judged, got ${JSON.stringify(r.v)}`);
    const quoted = await run(`npx jest --coverage -t "${KILL_SWITCH}=1"`, [LOW_MEM], STRICT);
    assert.equal(quoted.v.kind, 'deny');
  });

  it('does not let a bypass prefix on one segment cover a heavy command in another segment', async () => {
    const r = await run(`${KILL_SWITCH}=1 true; npx jest --coverage`, [LOW_MEM], STRICT);
    assert.equal(r.v.kind, 'deny');
    assert.equal(classify(`${KILL_SWITCH}=1 npx jest`).bypassed, 'jest');
  });

  it('does not accept the bypass with a value other than 1', async () => {
    const r = await run(`${KILL_SWITCH}=0 npx jest`, [LOW_MEM], STRICT);
    assert.equal(r.v.kind, 'deny');
  });
});
