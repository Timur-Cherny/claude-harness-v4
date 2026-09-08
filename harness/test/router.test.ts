// INVARIANT К2/I4: провал одного гейта не глушит остальные; kill-switch читается до любой работы;
// пейлоад без данных даёт unknown, а не тишину.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route, readPayload } from '../src/main.ts';
import { GATES, register } from '../src/gates/registry.ts';
import type { Gate } from '../src/types.ts';

const seen: string[] = [];
const mk = (name: string, run: Gate['run']): Gate => ({ name, events: ['pre-bash', 'post'], killSwitch: `CLAUDE_SKIP_${name.toUpperCase()}`, run });
register(mk('throws', () => { seen.push('throws'); throw new Error('boom\nстек не нужен'); }));
register(mk('denies', () => { seen.push('denies'); return { kind: 'deny', reason: 'нет', gate: 'denies' }; }));
register(mk('quiet', () => { seen.push('quiet'); return { kind: 'silent' }; }));

const env = { HOME: '/tmp/none', CLAUDE_STATE_DIR: '/tmp/none/state', HARNESS_ROOT: '/tmp/none/h' };
const p = { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } } as const;

describe('route', () => {
  it('runs every registered gate of the event even when an earlier one throws, and reports the throw as unknown(name)', async () => {
    seen.length = 0;
    const v = await route('post', p as never, env);
    assert.deepEqual(seen.sort(), ['denies', 'quiet', 'throws']);
    assert.equal(v.kind, 'deny');
    const ctxOnly = await route('post', p as never, { ...env, CLAUDE_SKIP_DENIES: '1' });
    assert.equal(ctxOnly.kind, 'context');
    assert.match((ctxOnly as { text: string }).text, /unknown\(throws\): boom$/);
  });
  it('skips a gate whose kill-switch is set before it does any work', async () => {
    seen.length = 0;
    await route('pre-bash', p as never, { ...env, CLAUDE_SKIP_THROWS: '1', CLAUDE_SKIP_DENIES: '1' });
    assert.deepEqual(seen, ['quiet']);
  });
  it('treats a missing or non-JSON payload as unknown — ask on pre, context on post — never as silent pass', async () => {
    assert.equal((await route('pre-bash', null, env)).kind, 'ask');
    assert.equal((await route('post', null, env)).kind, 'context');
    assert.equal(readPayload(''), null);
    assert.equal(readPayload('{"cwd":"/x"}'), null);
    assert.throws(() => readPayload('not json'));
  });
  it('registers each gate name once — a duplicate is a programming error, not a silent shadow', () => {
    assert.throws(() => register(mk('quiet', () => ({ kind: 'silent' }))), /дважды/);
    assert.equal(GATES.filter((g) => g.name === 'quiet').length, 1);
  });
});
