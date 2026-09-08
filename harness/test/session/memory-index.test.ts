// Молча ломалось бы: нота памяти без строки в MEMORY.md не читается в начале сессии — знание потеряно тихо.
// INVARIANT: сирота и строка «в никуда» доложены; ≤5 висячих [[ссылок]] — легальны; >5 — доложены;
// связный индекс — тишина; проект без памяти — тишина; Stop без transcript_path — unknown.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, inspect, KILL, NAME } from '../../src/session/memory-index.ts';
import { route } from '../../src/main.ts';
import type { GateContext } from '../../src/types.ts';

type Sb = ReturnType<typeof sandbox>;
function project(sb: Sb, name: string): { transcript: string; mem: string } {
  const proj = join(sb.home, '.claude', 'projects', name);
  const mem = join(proj, 'memory'); mkdirSync(mem, { recursive: true });
  const transcript = join(proj, 'session-1.jsonl'); writeFileSync(transcript, '');
  return { transcript, mem };
}
function note(mem: string, slug: string, body = 'тело'): void {
  writeFileSync(join(mem, `${slug}.md`), `---\nname: ${slug}\ndescription: проба\nmetadata:\n  type: project\n---\n${body}\n`);
}
function ctxFor(transcript: string | undefined): GateContext {
  return { event: 'stop', payload: payload('Stop', transcript ? { transcript_path: transcript } : {}) as never, env: {}, root: HARNESS_ROOT, stateDir: '/tmp/none', now: Date.now };
}

describe(NAME, () => {
  const sb = sandbox('harness-memidx-');
  after(() => sb.cleanup());

  it('names an orphan note that has no line in MEMORY.md and an index line pointing at a missing file', () => {
    const { transcript, mem } = project(sb, 'p1');
    note(mem, 'good-note'); note(mem, 'orphan-note');
    writeFileSync(join(mem, 'MEMORY.md'), '- [Good](good-note.md) — ok\n- [Gone](gone-note.md) — ведёт в никуда\n');
    const v = decide(ctxFor(transcript));
    assert.equal(v.kind, 'context');
    const t = (v as { text: string }).text;
    assert.match(t, /сирота, нет строки в индексе: orphan-note\.md/);
    assert.match(t, /строка индекса ведёт в никуда: gone-note\.md/);
    assert.doesNotMatch(t, /good-note/);
  });

  it('stays silent on a consistent index with up to 5 dead [[links]] and speaks at 6', () => {
    const { transcript, mem } = project(sb, 'p2');
    note(mem, 'a-note', '[[x1]] [[x2]] [[x3]] [[x4]] [[x5]] [[a-note]]');
    writeFileSync(join(mem, 'MEMORY.md'), '- [A](a-note.md) — ok\n');
    assert.equal(decide(ctxFor(transcript)).kind, 'silent');
    assert.equal(inspect(mem)?.deadLinks, 5);
    note(mem, 'a-note', '[[x1]] [[x2]] [[x3]] [[x4]] [[x5]] [[x6]]');
    const v = decide(ctxFor(transcript));
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /висячих ссылок 6/);
  });

  it('reports notes living without any MEMORY.md — the worst orphan state, which the original skipped', () => {
    const { transcript, mem } = project(sb, 'p3');
    note(mem, 'lonely');
    const v = decide(ctxFor(transcript));
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /индекса MEMORY\.md нет — все 1 нот/);
    rmSync(join(mem, 'lonely.md'));
    assert.equal(decide(ctxFor(transcript)).kind, 'silent', 'пустой каталог без индекса — не о чём говорить');
  });

  it('is silent for a project without a memory directory and unknown when transcript_path is absent', () => {
    const { transcript, mem } = project(sb, 'p4'); rmSync(mem, { recursive: true });
    assert.equal(decide(ctxFor(transcript)).kind, 'silent');
    const v = decide(ctxFor(undefined));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /transcript_path/);
  });

  it('is skipped by its kill-switch through route() even with an orphan present', async () => {
    const { transcript, mem } = project(sb, 'p5');
    note(mem, 'orphan'); writeFileSync(join(mem, 'MEMORY.md'), '');
    const v = await route('stop', payload('Stop', { transcript_path: transcript }, sb.dir) as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, [KILL]: '1', CLAUDE_SKIP_TREE_SWEEP: '1', CLAUDE_SKIP_CAPTURE_COMMITS: '1', CLAUDE_SKIP_GIT_FRESHNESS: '1' });
    assert.equal(v.kind, 'silent');
  });
});
