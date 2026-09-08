// INVARIANT I1/R7: отсутствие рантайма = unknown (ask на pre, тишина недопустима как «pass»);
// рантайм харнесса пинуется отдельно от рантайма проекта; префильтр pre-bash не запускает Node без слова-триггера.
// Молча ломалось: v3 бежал под `node` из PATH проекта (default nvm 22, CI node:18) — .ts там не стартует.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, runHook, fakeNode, bashPayload, payload, HARNESS_ROOT } from './_env.ts';

describe('bin/hook', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('answers ask with a reason on pre-events when no Node >= 24 exists — a missing runtime is missing data, not a pass', () => {
    const r = runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb);
    assert.equal(r.rc, 0);
    const j = r.json as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(j.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /install\.sh|CLAUDE_HARNESS_NODE/);
  });

  it('turns the same missing runtime into additionalContext when CLAUDE_HARNESS_UNKNOWN=note — the headless escape hatch is explicit, not silent', () => {
    const r = runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb, { CLAUDE_HARNESS_UNKNOWN: 'note' });
    const j = r.json as { hookSpecificOutput: { additionalContext?: string; permissionDecision?: string } };
    assert.equal(j.hookSpecificOutput.permissionDecision, undefined);
    assert.match(j.hookSpecificOutput.additionalContext ?? '', /Node >= 24/);
  });

  it('stays silent with rc 0 on post-events without a runtime and says it once per session on session-start', () => {
    const post = runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb);
    assert.deepEqual([post.rc, post.stdout, post.stderr], [0, '', '']);
    const first = runHook('session-start', payload('SessionStart'), sb, { CLAUDE_HARNESS_SESSION: 's1' });
    assert.match((first.json as { systemMessage: string }).systemMessage, /Node >= 24/);
    const second = runHook('session-start', payload('SessionStart'), sb, { CLAUDE_HARNESS_SESSION: 's1' });
    assert.equal(second.stdout, '');
  });

  it('rejects a PATH node below 24 — the project runtime (nvm default 22, CI node:18) never becomes the harness runtime', () => {
    const bin = join(sb.dir, 'bin22'); fakeNode(bin, '22.17.1');
    const r = runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb, {}, { path: `${bin}:/usr/bin:/bin` });
    assert.equal((r.json as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('uses CLAUDE_HARNESS_NODE first and hands it src/main.ts with the event name', () => {
    const rec = join(sb.dir, 'rec-env.txt'); const p = fakeNode(join(sb.dir, 'pin'), '24.99.0', rec);
    runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb, { CLAUDE_HARNESS_NODE: p });
    const lines = readFileSync(rec, 'utf8').trim().split('\n');
    assert.equal(lines[0], 'v24.99.0');
    assert.ok(lines.includes(join(HARNESS_ROOT, 'src', 'main.ts')), lines.join(' '));
    assert.equal(lines.at(-1), 'pre-agent');
  });

  it('picks v24.20.0 over v24.9.0 under ~/.nvm — numeric minor comparison, not lexicographic', () => {
    const rec = join(sb.dir, 'rec-nvm.txt');
    for (const v of ['24.9.0', '24.20.0', '18.20.5']) fakeNode(join(sb.home, '.nvm', 'versions', 'node', `v${v}`, 'bin'), v, rec);
    runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb);
    assert.equal(readFileSync(rec, 'utf8').split('\n')[0], 'v24.20.0');
  });

  it('carries CLAUDE_HARNESS_TS from harness.env into the child — without it the structural checks answer unknown', () => {
    const sb2 = sandbox('harness-shim-ts-');
    try {
      const bin = join(sb2.dir, 'bin');
      const node = fakeNode(bin, '24.20.0');
      const seen = join(sb2.dir, 'seen-ts.txt');
      writeFileSync(node, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\nprintf '%s' "$\{CLAUDE_HARNESS_TS:-NONE}" > '${seen}'\ncat >/dev/null\nexit 0\n`);
      mkdirSync(join(sb2.home, '.claude', 'env'), { recursive: true });
      writeFileSync(join(sb2.home, '.claude', 'env', 'harness.env'), `CLAUDE_HARNESS_NODE=${node}\nCLAUDE_HARNESS_TS=/pinned/typescript.js\n`);
      runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb2, {});
      assert.equal(readFileSync(seen, 'utf8'), '/pinned/typescript.js', 'пин TypeScript не доехал до роутера');
    } finally { sb2.cleanup(); }
  });

  it('reads ~/.claude/env/harness.env written by install.sh when no env override is set', () => {
    const sb2 = sandbox(); const rec = join(sb2.dir, 'rec.txt'); const p = fakeNode(join(sb2.dir, 'envnode'), '24.50.0', rec);
    mkdirSync(join(sb2.home, '.claude', 'env'), { recursive: true });
    writeFileSync(join(sb2.home, '.claude', 'env', 'harness.env'), `CLAUDE_HARNESS_NODE=${p}\n`);
    runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb2);
    assert.equal(readFileSync(rec, 'utf8').split('\n')[0], 'v24.50.0');
    sb2.cleanup();
  });

  it('does not start Node for a pre-bash command without trigger words, and does for `kubectl exec pod -- psql`', () => {
    const rec = join(sb.dir, 'rec-pre.txt'); const p = fakeNode(join(sb.dir, 'prenode'), '24.20.0', rec);
    runHook('pre-bash', bashPayload('ls -la && echo hi'), sb, { CLAUDE_HARNESS_NODE: p });
    assert.equal(existsSync(rec), false, 'Node запущен без слова-триггера');
    runHook('pre-bash', bashPayload("kubectl exec pod-x -- psql -c 'select 1'"), sb, { CLAUDE_HARNESS_NODE: p });
    assert.equal(existsSync(rec), true, 'Node не запущен при psql внутри команды');
  });

  it('exports NODE_COMPILE_CACHE under CLAUDE_STATE_DIR and HARNESS_ROOT as the physical harness path', () => {
    const rec = join(sb.dir, 'rec-envvars.txt');
    const bin = join(sb.dir, 'envprobe'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), `#!/bin/sh\n[ "$1" = "-v" ] && { echo v24.20.0; exit 0; }\nprintf '%s\\n%s\\n' "$NODE_COMPILE_CACHE" "$HARNESS_ROOT" > '${rec}'\ncat >/dev/null\n`, { mode: 0o755 });
    runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb, { CLAUDE_HARNESS_NODE: join(bin, 'node') });
    const [cache, root] = readFileSync(rec, 'utf8').trim().split('\n');
    assert.equal(cache, join(sb.stateDir, 'compile-cache'));
    assert.equal(root, HARNESS_ROOT);
  });
});
