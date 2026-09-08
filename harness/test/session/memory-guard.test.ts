// memory-guard: голодание памяти на Stop — предупреждение, не блок; здоровая машина — тишина.
// Молча ломалось (25.07.2026): сигнал free+inactive «видел» 3,7 GB при 0,07 GB свободных и трёх часах
// зависания; следующая редакция мерила абсолютный своп и кричала на здоровой машине с 1,6 GB шрама.
// INVARIANT: сигнал — доступная память сейчас и ПРИРОСТ свопа с прошлой остановки; занятый, но не растущий
// своп ничего не значит; нет обоих сигналов → unknown, не silent; kill-switch — ни строки в состояние.
// REGRESSION: маркер прошлого свопа живёт в State и обновляется каждым прогоном (первый — точка отсчёта).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide, defaults, NAME, KILL_SWITCH, MARKER_KEY, FREE_FLOOR_MB, SWAP_GROWTH_MAX_MB } from '../../src/session/memory-guard.ts';
import { route } from '../../src/main.ts';
import { State } from '../../src/state.ts';
import { GATES } from '../../src/gates/registry.ts';
import type { MemorySignal, SwapSignal } from '../../src/platform.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';
import { sandbox, payload } from '../_env.ts';

const HEALTHY: MemorySignal = { available_mb: 4500, constrained_mb: null, load_per_core: 0.3 };
const STARVED: MemorySignal = { available_mb: 120, constrained_mb: null, load_per_core: 2.5 };
const NO_MEM: MemorySignal = { available_mb: null, constrained_mb: null, load_per_core: 0.3, missing_reason: 'process.availableMemory недоступен' };
const NO_SWAP: SwapSignal = { used_mb: null, missing_reason: 'sysctl vm.swapusage не ответил' };
const swap = (used_mb: number): SwapSignal => ({ used_mb });

function ctxFor(stateDir: string, at = 1_700_000_000_000): GateContext {
  return { event: 'stop', payload: payload('Stop') as unknown as HookPayload, env: {}, root: '/tmp/none/h', stateDir, now: () => at };
}
function judge(stateDir: string, mem: MemorySignal, sw: SwapSignal, at?: number): Verdict {
  return decide(ctxFor(stateDir, at), { memory: () => mem, swap: () => sw });
}
function marker(stateDir: string): string | null {
  const st = State.open(stateDir); try { return st.marker(MARKER_KEY); } finally { st.close(); }
}
const text = (v: Verdict): string => (v as { text: string }).text;

describe('memory-guard: bash corpus (hooks/memory-guard.sh, 25.07 rules)', () => {
  it('is silent on a healthy machine and records the swap level as the baseline for the next stop', () => {
    const sb = sandbox();
    try {
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(1600)), { kind: 'silent' });
      assert.equal(marker(sb.stateDir), '1600');
    } finally { sb.cleanup(); }
  });

  it('stays silent when swap is large but static — the scar of a past incident is not starvation', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1600));
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(1600)), { kind: 'silent' });
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(1750)), { kind: 'silent' }, `growth of 150 is below ${SWAP_GROWTH_MAX_MB}`);
    } finally { sb.cleanup(); }
  });

  it('warns when swap grew by more than SWAP_GROWTH_MAX_MB since the previous stop — growth, not level, is the signal', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1000));
      const v = judge(sb.stateDir, HEALTHY, swap(1300));
      assert.equal(v.kind, 'context');
      assert.match(text(v), /своп вырос на 300MB/);
      assert.doesNotMatch(text(v), /доступно/);
      assert.equal(marker(sb.stateDir), '1300', 'the new level becomes the next baseline');
    } finally { sb.cleanup(); }
  });

  it('does not report growth on the very first stop — the first reading is only a baseline', () => {
    const sb = sandbox();
    try {
      assert.deepEqual(judge(sb.stateDir, HEALTHY, swap(5000)), { kind: 'silent' });
    } finally { sb.cleanup(); }
  });

  it('warns when available memory is below FREE_FLOOR_MB and names memory, not swap', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, STARVED, swap(1600));
      assert.equal(v.kind, 'context');
      assert.match(text(v), new RegExp(`доступно 120MB \\(порог ${FREE_FLOOR_MB}MB\\)`));
      assert.doesNotMatch(text(v), /своп вырос/);
      assert.equal((v as { gate: string }).gate, NAME);
    } finally { sb.cleanup(); }
  });

  it('lists both reasons when memory is low and swap is growing at the same time', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(1000));
      const v = judge(sb.stateDir, STARVED, swap(1400));
      assert.match(text(v), /доступно 120MB/);
      assert.match(text(v), /своп вырос на 400MB/);
    } finally { sb.cleanup(); }
  });

  it('never blocks: the worst case is a context line, no deny/block verdict exists in this module', () => {
    const sb = sandbox();
    try {
      judge(sb.stateDir, HEALTHY, swap(0));
      const v = judge(sb.stateDir, { ...STARVED, available_mb: 0 }, swap(9000));
      assert.equal(v.kind, 'context');
    } finally { sb.cleanup(); }
  });
});

describe('memory-guard: missing signals', () => {
  it('answers unknown naming both missing signals when neither memory nor swap can be read', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, NO_MEM, NO_SWAP);
      assert.equal(v.kind, 'unknown');
      const reason = (v as { reason: string }).reason;
      assert.match(reason, /availableMemory/);
      assert.match(reason, /vm\.swapusage/);
      assert.equal(existsSync(join(sb.stateDir, 'harness.db')), false, 'no swap reading → nothing to store');
    } finally { sb.cleanup(); }
  });

  it('answers unknown for the one missing signal when the other is healthy — a half-read is not a clean bill', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, HEALTHY, NO_SWAP);
      assert.equal(v.kind, 'unknown');
      assert.match((v as { reason: string }).reason, /своп/);
      assert.doesNotMatch((v as { reason: string }).reason, /память/);
      const w = judge(sb.stateDir, NO_MEM, swap(100));
      assert.equal(w.kind, 'unknown');
      assert.match((w as { reason: string }).reason, /память/);
    } finally { sb.cleanup(); }
  });

  it('still warns on the signal it has when the other one is missing — starvation outranks missing data', () => {
    const sb = sandbox();
    try {
      const v = judge(sb.stateDir, STARVED, NO_SWAP);
      assert.equal(v.kind, 'context');
      assert.match(text(v), /доступно 120MB/);
      judge(sb.stateDir, NO_MEM, swap(100));
      const w = judge(sb.stateDir, NO_MEM, swap(900));
      assert.equal(w.kind, 'context');
      assert.match(text(w), /своп вырос на 800MB/);
    } finally { sb.cleanup(); }
  });
});

describe('memory-guard: routing on `stop`', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  // Соседние гейты события stop гасятся своими выключателями: проверяется поведение ЭТОГО гейта, не их.
  const siblingsOff = Object.fromEntries(GATES.filter((g) => g.events.includes('stop') && g.name !== NAME).map((g) => [g.killSwitch, '1']));
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT: '/tmp/none/h', ...siblingsOff };

  it('kill-switch via route(): silent, gate body never runs, no database is created in the state dir', async () => {
    const orig = defaults.memory;
    defaults.memory = () => { throw new Error('gate body ran despite kill-switch'); };
    try {
      assert.equal(KILL_SWITCH, 'CLAUDE_SKIP_MEMORY_GUARD', 'the bash kill-switch name is kept verbatim');
      const v = await route('stop', payload('Stop') as unknown as HookPayload, { ...env, CLAUDE_SKIP_MEMORY_GUARD: '1' });
      assert.deepEqual(v, { kind: 'silent' });
      assert.deepEqual(readdirSync(sb.stateDir), []);
      // Без выключателя шпион срабатывает: тело исполнилось, провал стал unknown → context на stop.
      const c = await route('stop', payload('Stop') as unknown as HookPayload, env);
      assert.equal(c.kind, 'context');
      assert.match(text(c), /unknown\(memory-guard\): gate body ran/);
    } finally { defaults.memory = orig; }
  });

  it('lifts unknown to a context line on stop (never silent) when the platform gives no signals', async () => {
    const origM = defaults.memory; const origS = defaults.swap;
    defaults.memory = () => NO_MEM; defaults.swap = () => NO_SWAP;
    try {
      const v = await route('stop', payload('Stop') as unknown as HookPayload, env);
      assert.equal(v.kind, 'context');
      assert.match(text(v), /unknown\(memory-guard\): нет сигнала/);
    } finally { defaults.memory = origM; defaults.swap = origS; }
  });

  it('runs the real platform signals without throwing and returns one of silent/context/unknown', async () => {
    const v = await route('stop', payload('Stop') as unknown as HookPayload, env);
    assert.ok(['silent', 'context'].includes(v.kind), JSON.stringify(v));
  });
});
