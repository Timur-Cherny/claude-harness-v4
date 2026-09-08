// R5: сверка на PostToolUse при неизменном дереве укладывается в бюджет — медиана ≤ 100 мс сквозь bin/hook
// (шим + Node с compile cache + git status + sqlite). Гоняется только с HARNESS_BENCH=1: цифра зависит от машины.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sandbox, HARNESS_ROOT, NODE_BIN, payload } from '../_env.ts';
import { memory } from '../../src/platform.ts';

const BENCH = process.env.HARNESS_BENCH === '1';

// Насыщенная машина меряет себя, а не сверку: 06.09 при load 9 и ~100 МБ свободной памяти медиана
// монотонно росла от прогона к прогону (98 → 130 → 125 → 157 мс) на неизменном коде. Такой прогон
// не краснеет и не зеленеет — он не состоялся, и это единственный честный исход.
const SATURATED = { min_free_mb: 500, max_load_per_core: 1.5 };

describe('latency', { skip: !BENCH && 'HARNESS_BENCH=1 to run' }, () => {
  it('keeps the median post-event under 100 ms on a 1000-file repo with an unchanged tree', (t) => {
    const m = memory();
    const free = m.available_mb;
    if (free !== null && free < SATURATED.min_free_mb) return t.skip(`машина насыщена: свободно ${free} МБ < ${SATURATED.min_free_mb}, замер не состоялся`);
    if (m.load_per_core > SATURATED.max_load_per_core) return t.skip(`машина насыщена: load ${m.load_per_core.toFixed(2)}/ядро > ${SATURATED.max_load_per_core}, замер не состоялся`);
    const sb = sandbox();
    const repo = join(sb.dir, 'repo'); mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    for (let i = 0; i < 1000; i++) { const d = join(repo, `m${i % 20}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `f${i}.ts`), `export const v${i} = ${i};\n`); }
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true }); for (let i = 0; i < 2000; i++) writeFileSync(join(repo, 'node_modules', 'pkg', `x${i}.js`), '1');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: repo });
    const env = { PATH: process.env.PATH ?? '', HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, CLAUDE_HARNESS_NODE: NODE_BIN };
    const input = JSON.stringify(payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'warm' }, repo));
    spawnSync('sh', [join(HARNESS_ROOT, 'bin', 'hook'), 'post'], { input, env, encoding: 'utf8' }); // прогрев compile cache и кэша корня
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      const r = spawnSync('sh', [join(HARNESS_ROOT, 'bin', 'hook'), 'post'], { input: input.replace('"warm"', `"t${i}"`), env, encoding: 'utf8' });
      times.push(performance.now() - t);
      assert.equal(r.status, 0, r.stderr);
    }
    times.sort((a, b) => a - b);
    const median = times[4];
    console.log(`post latency ms: median ${median.toFixed(1)}, min ${times[0].toFixed(1)}, max ${times[8].toFixed(1)}`);
    assert.ok(median <= 100, `медиана ${median.toFixed(1)} мс > 100`);
    sb.cleanup();
  });
});
