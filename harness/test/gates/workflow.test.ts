// Порт hooks/workflow-friction-gate.sh и Workflow-ветки hooks/model-gate.sh на TS-AST.
// Молча ломалось: grep по JS — комментарий `// friction`, переменная "frictionless" и динамический prompt
// проходили или отвергались текстом, а не структурой (К1, deny-gates.test.sh:69-71).
// INVARIANT: каждый статический вызов agent() требует «Трение»/friction в доказуемо-статичном prompt либо schema.properties.friction;
// свойство model в opts второго аргумента → deny. REGRESSION: комментарий и похожее слово контракт не выполняют.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT, TS_PATH } from '../_env.ts';
import { decideFriction, decideModel, NAME, MODEL_NAME } from '../../src/gates/workflow.ts';
import { GATES } from '../../src/gates/registry.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';


const sb = sandbox();
after(() => sb.cleanup());

function wf(script: string, extra: Record<string, unknown> = {}): HookPayload {
  return payload('PreToolUse', { tool_name: 'Workflow', tool_input: { script, ...extra }, tool_use_id: 'toolu_wf' }, sb.dir) as unknown as HookPayload;
}
function ctx(p: HookPayload, env: Record<string, string> = { CLAUDE_HARNESS_TS: TS_PATH }): GateContext {
  return { event: 'pre-agent', payload: p, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
}
const friction = (script: string, env?: Record<string, string>): Verdict => decideFriction(ctx(wf(script), env));
const model = (script: string, env?: Record<string, string>): Verdict => decideModel(ctx(wf(script), env));
const reason = (v: Verdict): string => ('reason' in v ? v.reason : '');

describe('workflow-friction-gate (bash corpus)', () => {
  it('registers both gates on pre-agent with the bash kill-switch names', () => {
    const f = GATES.find((g) => g.name === NAME); const m = GATES.find((g) => g.name === MODEL_NAME);
    assert.deepEqual([f?.killSwitch, m?.killSwitch], ['CLAUDE_SKIP_FRICTION_GATE', 'CLAUDE_SKIP_MODEL_GATE']);
    assert.deepEqual([f?.events, m?.events], [['pre-agent'], ['pre-agent']]);
  });
  it('denies agent() whose prompt never asks for «Трение»', () => {
    const v = friction('const r=await agent("найди баги")');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /L1\b/); assert.match(reason(v), /Трение/);
  });
  it('allows a prompt that requires «Трение»', () => { assert.equal(friction('const r=await agent("найди баги. Заверши секцией ## Трение")').kind, 'silent'); });
  it('allows a schema with a friction field passed through a variable', () => {
    assert.equal(friction('const S={type:"object",properties:{friction:{type:"string"}}}\nawait agent("x",{schema:S})').kind, 'silent');
  });
  it('stays silent on a script without agent()', () => { assert.equal(friction('log("hi")').kind, 'silent'); });
  it('denies when only a comment mentions friction — a comment is not a contract (К1)', () => {
    assert.equal(friction('// friction: ничего\nconst r=await agent("найди баги")').kind, 'deny');
  });
  it('denies when the word appears as a variable "frictionless" elsewhere (К1)', () => {
    assert.equal(friction('const n="frictionless"\nawait agent("найди баги")').kind, 'deny');
  });
  it('denies a dynamic prompt that cannot be proven — buildPrompt() is not evidence', () => {
    const v = friction('const p=buildPrompt(); await agent(p)');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /динамич/);
  });
  it('denies when one of two agent() calls lacks the section and names that line', () => {
    const v = friction('await agent("## Трение обязательно");\nawait agent("просто отчёт")');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /L2\b/); assert.doesNotMatch(reason(v), /L1\b/);
  });
  it('allows two calls when both prompts require the section, in either language', () => {
    assert.equal(friction('await agent("## Трение обязательно"); await agent("Add ## Friction")').kind, 'silent');
  });
});

describe('workflow-friction-gate (structural cases beyond the bash corpus)', () => {
  it('resolves a const string identifier to its literal — the contract is proven, not guessed', () => {
    assert.equal(friction('const p = "Отчёт заверши секцией ## Трение"; await agent(p)').kind, 'silent');
  });
  it('accepts the word inside the static part of a template literal and a literal concatenation', () => {
    assert.equal(friction('const task = load(); await agent(`Сделай ${task}. Заверши ## Трение`)').kind, 'silent');
    assert.equal(friction('await agent("найди баги. " + "## Трение обязательно")').kind, 'silent');
  });
  it('denies a template whose only friction word sits inside an interpolation', () => {
    assert.equal(friction('const w = "Трение"; await agent(`найди баги ${w()}`)').kind, 'deny');
  });
  it('denies a literal schema without a friction property and a schema imported from elsewhere', () => {
    assert.equal(friction('await agent("x", {schema: {type:"object", properties: {name: {type:"string"}}}})').kind, 'deny');
    const v = friction('import { S } from "./schema.ts"; await agent("x", {schema: S})');
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /schema/);
  });
  it('denies "frictionless" and «Трением» in the prompt itself — whole-word match in both alphabets', () => {
    assert.equal(friction('await agent("be frictionless about it")').kind, 'deny');
    assert.equal(friction('await agent("с Трением не считается")').kind, 'deny');
  });
  it('counts a property call ctx.agent(...) as an agent call', () => {
    assert.equal(friction('await ctx.agent("найди баги")').kind, 'deny');
    assert.equal(friction('await ctx.agent("найди баги; ## Трение")').kind, 'silent');
  });
  it('reads the script from scriptPath when script is absent, and answers unknown when the path is unreadable', () => {
    const p = join(sb.dir, 'wf.ts'); writeFileSync(p, 'await agent("найди баги")\n');
    const denied = decideFriction(ctx(wf('', { script: undefined, scriptPath: p })));
    assert.equal(denied.kind, 'deny');
    const missing = decideFriction(ctx(wf('', { script: undefined, scriptPath: join(sb.dir, 'absent.ts') })));
    assert.equal(missing.kind, 'unknown'); assert.match(reason(missing), /scriptPath/);
  });
  it('answers unknown when no typescript is reachable and when the script does not parse', () => {
    const noTs = friction('await agent("найди баги")', {});
    assert.equal(noTs.kind, 'unknown'); assert.match(reason(noTs), /typescript/i);
    const broken = friction('await agent("найди баги"');
    assert.equal(broken.kind, 'unknown'); assert.match(reason(broken), /разобран/);
  });
  it('stays silent for a non-Workflow tool and for an empty script', () => {
    const agentTool = payload('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'x' } }) as unknown as HookPayload;
    assert.equal(decideFriction(ctx(agentTool)).kind, 'silent');
    assert.equal(friction('').kind, 'silent');
  });
});

describe('workflow-model-gate', () => {
  it('denies opts.model for fable and opus alike — any explicit model, no allowlist', () => {
    for (const m of ['claude-fable-5', 'claude-opus-5']) {
      const v = model(`await agent("x",{model:"${m}"})`);
      assert.equal(v.kind, 'deny', m); assert.match(reason(v), /L1\b/); assert.match(reason(v), /наследовать/);
    }
  });
  it('denies model reached through a variable, a shorthand property and a spread', () => {
    assert.equal(model('const o={model:"claude-opus-5"}; await agent("## Трение", o)').kind, 'deny');
    assert.equal(model('const model="claude-opus-5"; await agent("## Трение", {model})').kind, 'deny');
    assert.equal(model('const base={model:"x"}; await agent("## Трение", {...base, maxTurns: 2})').kind, 'deny');
  });
  it('allows opts without model, a variable named model outside opts, and a script without agent()', () => {
    assert.equal(model('const S={properties:{friction:{}}}; await agent("x",{schema:S})').kind, 'silent');
    assert.equal(model('const model="claude-fable-5"; await agent("## Трение", {maxTurns: 3})').kind, 'silent');
    assert.equal(model('log("hi")').kind, 'silent');
  });
  it('answers unknown without typescript', () => { assert.equal(model('await agent("x",{model:"claude-fable-5"})', {}).kind, 'unknown'); });
});

describe('kill-switches through route()', () => {
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, CLAUDE_HARNESS_TS: TS_PATH };
  it('CLAUDE_SKIP_FRICTION_GATE=1 silences the friction gate while the model gate still denies opts.model', async () => {
    const v = await route('pre-agent', wf('await agent("найди баги",{model:"claude-fable-5"})'), { ...env, CLAUDE_SKIP_FRICTION_GATE: '1' });
    assert.equal(v.kind, 'deny'); assert.equal((v as { gate: string }).gate, MODEL_NAME);
  });
  it('both switches set → silent verdict and no files written under the state dir', async () => {
    const v = await route('pre-agent', wf('await agent("найди баги",{model:"claude-fable-5"})'), { ...env, CLAUDE_SKIP_FRICTION_GATE: '1', CLAUDE_SKIP_MODEL_GATE: '1' });
    assert.equal(v.kind, 'silent');
    assert.deepEqual(readdirSync(sb.stateDir), []);
  });
  it('without switches route() denies and names both gates', async () => {
    const v = await route('pre-agent', wf('await agent("найди баги",{model:"claude-fable-5"})'), env);
    assert.equal(v.kind, 'deny'); assert.match(reason(v), /Трение/); assert.match(reason(v), /наследовать/);
  });
});
