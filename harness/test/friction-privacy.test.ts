// Порт hooks/spec/capture-friction-metadata.test.sh. INVARIANT I3: в событии трения только метки и счётчики —
// ни путей, ни содержимого, ни поля вне WHITELIST.friction; last_assistant_message и транскрипт не читаются
// (ADR решение 1). INVARIANT I6: параллельные SubagentStop дают целые строки без потерь.
// Молча ломалось: cwd шёл в улики, а classify первой редакции мог вернуть путь в missing_reason.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../src/main.ts';
import { WHITELIST } from '../src/journal.ts';
import '../src/friction.ts';
import { sandbox, payload, NODE_BIN, HARNESS_ROOT } from './_env.ts';
import type { Sandbox } from './_env.ts';

const SECRET = {
  agent_transcript_path: '/private/session/agent-1.jsonl',
  last_assistant_message: 'SECRET_REPORT_BODY',
  tool_input: { command: 'SECRET_SHELL_INPUT', file_path: '/private/source.ts' },
};
const LEAK = /SECRET_REPORT_BODY|SECRET_SHELL_INPUT|\/private\/|secret_filename|СЕКРЕТНАЯ_СТРОКА/;

function env(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> { return { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, CLAUDE_SKIP_TREE_SWEEP: '1', ...extra }; }
function journal(sb: Sandbox): string { return join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl'); }
function lines(sb: Sandbox): string[] { return existsSync(journal(sb)) ? readFileSync(journal(sb), 'utf8').split('\n').filter(Boolean) : []; }
function gitRepo(sb: Sandbox, name: string): string {
  const repo = join(sb.dir, name); mkdirSync(repo, { recursive: true });
  for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty']]) {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr);
  }
  return repo;
}

describe('friction privacy', () => {
  const sb = sandbox('harction-priv-');
  after(() => sb.cleanup());

  it('writes exactly one metadata event for a SubagentStop outside git, with the declared schema and none of the private payload', async () => {
    const dir = join(sb.dir, 'private-project'); mkdirSync(dir, { recursive: true });
    const v = await route('agent-stop', payload('SubagentStop', { agent_id: 'agent-1', agent_type: 'worker', ...SECRET }, dir) as never, env(sb));
    assert.equal(v.kind, 'context');
    assert.doesNotMatch(JSON.stringify(v), LEAK, 'verdict text leaks payload');
    const ls = lines(sb); assert.equal(ls.length, 1);
    const e = JSON.parse(ls[0]) as Record<string, unknown>;
    assert.equal(e.adapter, 'claude-friction-2'); assert.equal(e.executor, 'local-agent'); assert.equal(e.source_class, 'subagent-stop');
    assert.equal(e.session, 'session-1'); assert.equal(e.agent_id, 'agent-1'); assert.equal(e.agent_type, 'worker');
    assert.equal(e.outcome, 'completed'); assert.equal(e.verification_state, 'unknown');
    assert.equal(e.narrative_friction_state, 'unavailable'); assert.equal(e.narrative_missing_reason, 'structured_friction_signal_not_exposed');
    assert.equal(e.friction_state, 'unavailable'); assert.equal(e.missing_reason, 'not_a_git_repo'); assert.equal('attribution' in e, false);
    assert.doesNotMatch(ls[0], LEAK, 'private payload content leaked');
  });
  it('holds privacy by the whitelist, not by a list of known secrets — every key is declared in WHITELIST.friction and no string value carries a path', async () => {
    const repo = gitRepo(sb, 'repo-secret');
    mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'secret_filename.py'), 'СЕКРЕТНАЯ_СТРОКА_В_КОДЕ\n');
    const v = await route('agent-stop', payload('SubagentStop', { agent_id: 'agent-2', agent_type: 'worker', ...SECRET }, repo) as never, env(sb));
    assert.doesNotMatch(JSON.stringify(v), LEAK);
    const ls = lines(sb); assert.equal(ls.length, 2);
    for (const l of ls) {
      assert.doesNotMatch(l, LEAK, 'path, file name or content leaked into telemetry');
      const e = JSON.parse(l) as Record<string, unknown>;
      const extra = Object.keys(e).filter((k) => !WHITELIST.friction.has(k));
      assert.deepEqual(extra, [], `undeclared fields: ${extra.join(',')}`);
      for (const [k, val] of Object.entries(e)) if (typeof val === 'string') assert.doesNotMatch(val, /\//, `field ${k} carries a path`);
    }
    const e = JSON.parse(ls[1]) as Record<string, unknown>;
    assert.equal(e.files_changed, 1); assert.equal(e.scope, 'function');
  });
  it('appends nothing under CLAUDE_SKIP_FRICTION=1', async () => {
    const before = lines(sb).length;
    await route('agent-stop', payload('SubagentStop', { agent_id: 'agent-3', agent_type: 'worker', ...SECRET }, sb.dir) as never, env(sb, { CLAUDE_SKIP_FRICTION: '1' }));
    assert.equal(lines(sb).length, before);
  });
  it('keeps 12 parallel SubagentStop processes on one repo as 12 whole JSON lines with no private body', async () => {
    const repo = gitRepo(sb, 'repo-par'); mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'p.py'), 'x=1\n');
    const script = join(sb.dir, 'stop.ts');
    writeFileSync(script, [
      `import { route } from '${HARNESS_ROOT}/src/main.ts';`,
      `import '${HARNESS_ROOT}/src/friction.ts';`,
      `const i = process.argv[2];`,
      `const p = { session_id: 'session-1', cwd: ${JSON.stringify(repo)}, hook_event_name: 'SubagentStop', agent_id: 'a' + i, agent_type: 'worker', agent_transcript_path: '/x/a' + i + '.jsonl', last_assistant_message: 'SECRET_' + i };`,
      `await route('agent-stop', p as never, { HOME: ${JSON.stringify(sb.home)}, CLAUDE_STATE_DIR: ${JSON.stringify(sb.stateDir)}, CLAUDE_SKIP_TREE_SWEEP: '1' });`,
      `console.log('ok');`, ''].join('\n'));
    const before = lines(sb).length;
    const r = spawnSync('sh', ['-c', `for i in $(seq 1 12); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" $i & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/ok/g) ?? []).length, 12, r.stderr);
    const ls = lines(sb);
    assert.equal(ls.length, before + 12);
    for (const l of ls) { assert.doesNotThrow(() => JSON.parse(l), l.slice(0, 80)); assert.doesNotMatch(l, /SECRET_|\/x\//); }
  });
});
