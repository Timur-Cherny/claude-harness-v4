// Молча ломалось: разрешённый список моделей устаревал и давал усилить модель «другим именем»;
// гейт без теста на норму мог оказаться стеной, без теста на нарушение — мёртвым (deny-gates.test.sh).
// INVARIANT: любой непустой `model` у Agent/Task → deny; отсутствие/пустое/null → silent; tool_input не объект →
// unknown, не silent. REGRESSION: контракты сняты пробой 28.08, не выведены из кода.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/gates/model-gate.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox();
after(() => sb.cleanup());

function agent(tool: string, input: Record<string, unknown> | undefined): HookPayload {
  const p = payload('PreToolUse', { tool_name: tool, tool_use_id: 'toolu_a' }) as Record<string, unknown>;
  if (input !== undefined) p.tool_input = input;
  return p as unknown as HookPayload;
}
function run(p: HookPayload, env: NodeJS.ProcessEnv = {}): Verdict {
  const ctx: GateContext = { event: 'pre-agent', payload: p, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
  return decide(ctx);
}

describe(NAME, () => {
  describe('denies every explicit model — there is no allowed list to outgrow', () => {
    for (const m of ['claude-fable-5', 'fable', 'claude-opus-5', 'claude-sonnet-5', 'haiku']) {
      it(`Agent model=${m}`, () => {
        const v = run(agent('Agent', { model: m, prompt: 'x', description: 'y' }));
        assert.equal(v.kind, 'deny');
        assert.match((v as { reason: string }).reason, new RegExp(`model=${m}`));
        assert.match((v as { reason: string }).reason, /наследовать модель родителя/);
      });
    }
    it('Task tool with a model is the same contract', () => {
      assert.equal(run(agent('Task', { model: 'claude-opus-5', prompt: 'x' })).kind, 'deny');
    });
    it('a non-string model (object) is still an explicit override', () => {
      const v = run(agent('Agent', { model: { id: 'x' }, prompt: 'x' }));
      assert.equal(v.kind, 'deny');
      assert.match((v as { reason: string }).reason, /"id":"x"/);
    });
  });

  describe('stays silent when the model is inherited — for different reasons', () => {
    it('Agent without a model key', () => { assert.equal(run(agent('Agent', { prompt: 'x', description: 'y' })).kind, 'silent'); });
    it('model given as empty string', () => { assert.equal(run(agent('Agent', { model: '', prompt: 'x' })).kind, 'silent'); });
    it('model given as null', () => { assert.equal(run(agent('Agent', { model: null, prompt: 'x' })).kind, 'silent'); });
    it('a Workflow script mentioning model — checked by the TS-AST structural gate, not here', () => {
      assert.equal(run(agent('Workflow', { script: 'await agent("x",{model:"claude-fable-5"})' })).kind, 'silent');
    });
    it('a non-agent tool on the same event', () => { assert.equal(run(agent('Bash', { command: 'claude --model opus' })).kind, 'silent'); });
  });

  describe('unknown when the payload carries no readable tool_input', () => {
    it('tool_input missing → unknown with a reason, not a pass', () => {
      const v = run(agent('Agent', undefined));
      assert.equal(v.kind, 'unknown');
      assert.match((v as { reason: string }).reason, /tool_input/);
    });
    it('tool_input not an object → unknown', () => {
      assert.equal(run(agent('Agent', 'model=fable' as unknown as Record<string, unknown>)).kind, 'unknown');
    });
  });

  describe('through the router', () => {
    const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
    it('kill-switch CLAUDE_SKIP_MODEL_GATE=1 → silent and nothing written to state or journals', async () => {
      const v = await route('pre-agent', agent('Agent', { model: 'claude-fable-5', prompt: 'x' }), { ...env, CLAUDE_SKIP_MODEL_GATE: '1' });
      assert.equal(v.kind, 'silent');
      assert.deepEqual(readdirSync(sb.stateDir), []);
      assert.deepEqual(readdirSync(sb.home), []);
    });
    it('without the switch the same payload is denied with the gate name', async () => {
      const v = await route('pre-agent', agent('Agent', { model: 'claude-fable-5', prompt: 'x' }), env);
      assert.equal(v.kind, 'deny');
      assert.equal((v as { gate: string }).gate, NAME);
    });
    it('a missing tool_input becomes ask on a pre-event (unknown never collapses to silent)', async () => {
      const v = await route('pre-agent', agent('Agent', undefined), env);
      assert.equal(v.kind, 'ask');
    });
  });
});
