// INVARIANT I3/I6: в personal.jsonl/corp.jsonl уходят только токены, длительности и sha256-метки;
// ни байта промпта, отчёта или имени файла — ни в журнале, ни в harness.db. Параллельные Stop-хуки
// не двоят события: офсет читается и сдвигается под одним замком. Контуры раздельны.
// REGRESSION: python-оригинал хранил накопитель в state.json без замка на чтение-запись; здесь
// накопительная семантика та же (потребитель берёт ПОСЛЕДНЕЕ событие на session), но офсеты и
// накопитель живут в одной транзакции с записью журнала.
import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { decide, readTail, codexUsage, messageUsage, sourceId, NAME, KILL_SWITCH } from '../src/telemetry.ts';
import { GATES } from '../src/gates/registry.ts';
import { WHITELIST } from '../src/journal.ts';
import { State } from '../src/state.ts';
import { route } from '../src/main.ts';
import { sandbox, payload, NODE_BIN, HARNESS_ROOT, onlyGate, type Sandbox } from './_env.ts';
import type { GateContext } from '../src/types.ts';

const CODEX_LINE = (input: number, cached: number, output: number) =>
  JSON.stringify({ payload: { info: { total_token_usage: { total_tokens: input + output, input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } } }, private: 'SECRET_CODEX_BODY' }) + '\n';
const MSG_LINE = (input: number, write: number, read: number, output: number, secret: string) =>
  JSON.stringify({ message: { usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output }, content: secret } }) + '\n';

interface Fx { codex: string; local: string; corp: string; done: string }
function layout(sb: Sandbox): Fx {
  const fx = {
    codex: join(sb.home, '.codex', 'sessions', '2026', 'session-codex.jsonl'),
    local: join(sb.home, '.claude', 'projects', 'project', 'subagents', 'agent-local.jsonl'),
    corp: join(sb.home, '.claude-corp', 'projects', 'project', 'session-corp.jsonl'),
    done: join(sb.home, '.claude-corp', 'tasks', 'done'),
  };
  for (const p of [fx.codex, fx.local, fx.corp]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); }
  mkdirSync(fx.done, { recursive: true });
  return fx;
}
function ctx(sb: Sandbox, env: Record<string, string | undefined> = {}, now = Date.now): GateContext {
  return { event: 'stop', payload: payload('Stop') as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, ...env }, root: HARNESS_ROOT, stateDir: sb.stateDir, now };
}
function events(sb: Sandbox, contour: 'personal' | 'corp'): Record<string, unknown>[] {
  const p = join(sb.stateDir, `${contour}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function ageFile(p: string, hoursAgo: number): void { const t = (Date.now() - hoursAgo * 3600_000) / 1000; utimesSync(p, t, t); }
function offsetOf(sb: Sandbox, p: string): number | null {
  const st = State.open(sb.stateDir);
  try { const r = st.db.prepare('SELECT offset FROM telemetry_offsets WHERE transcript_hash = ?').get(sourceId(p)) as { offset: number } | undefined; return r?.offset ?? null; }
  finally { st.close(); }
}

describe('telemetry gate registration', () => {
  it('registers on the stop event under the kill-switch name of the bash original', () => {
    const g = GATES.find((x) => x.name === NAME);
    assert.ok(g, 'gate not registered');
    assert.deepEqual(g.events, ['stop']);
    assert.equal(g.killSwitch, 'CLAUDE_SKIP_AI_USAGE');
    assert.equal(KILL_SWITCH, 'CLAUDE_SKIP_AI_USAGE');
  });
});

describe('metadata-only contract (port of telemetry-metadata.test.sh)', () => {
  const sb = sandbox(); let fx: Fx;
  before(() => {
    fx = layout(sb);
    assert.equal(decide(ctx(sb)).kind, 'silent'); // seed run
    appendFileSync(fx.codex, CODEX_LINE(6, 2, 2));
    appendFileSync(fx.local, MSG_LINE(3, 1, 2, 4, 'SECRET_LOCAL_BODY'));
    appendFileSync(fx.corp, MSG_LINE(5, 1, 2, 3, 'SECRET_CORP_BODY'));
    writeFileSync(join(fx.done, 'REPORT_SECRET_NAME.md'), 'SECRET_REPORT_BODY\n');
    assert.equal(decide(ctx(sb)).kind, 'silent');
  });
  after(() => sb.cleanup());

  it('writes two personal and two corp events after the first collecting run (seed run writes none)', () => {
    assert.equal(events(sb, 'personal').length, 2);
    assert.equal(events(sb, 'corp').length, 2);
  });
  it('keeps Codex and the local agent in the personal contour', () => {
    const ex = events(sb, 'personal').map((e) => e.executor).sort();
    assert.deepEqual(ex, ['codex', 'local-agent']);
  });
  it('keeps the corp stream free of Codex and holds corp-claude only', () => {
    const ex = events(sb, 'corp').map((e) => e.executor);
    assert.equal(ex.filter((x) => x === 'codex').length, 0);
    assert.deepEqual([...new Set(ex)], ['corp-claude']);
  });
  it('maps token fields into the whitelist names — local agent 3/1/2/4, codex 6/-/2/2', () => {
    const local = events(sb, 'personal').find((e) => e.executor === 'local-agent')!;
    assert.deepEqual([local.input_tokens, local.cache_write, local.cache_read, local.output_tokens], [3, 1, 2, 4]);
    const codex = events(sb, 'personal').find((e) => e.executor === 'codex')!;
    assert.deepEqual([codex.input_tokens, codex.cache_write, codex.cache_read, codex.output_tokens], [6, 0, 2, 2]);
    assert.equal(local.event, 'agent-transcript'); assert.equal(codex.event, 'session-transcript');
  });
  it('emits a task-report event as an opaque hash — no report name, no report body, no report_id key outside the whitelist', () => {
    const rep = events(sb, 'corp').find((e) => e.event === 'task-report')!;
    assert.ok(rep, 'task-report event missing');
    assert.equal('report' in rep, false); assert.equal('report_id' in rep, false);
    assert.match(String(rep.session), /^report:[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(rep).includes('SECRET'), false);
  });
  it('leaks no private content into the telemetry directory — journals AND harness.db are grepped byte-wise', () => {
    const re = /SECRET_(CODEX|LOCAL|CORP|REPORT|NAME)/;
    for (const f of readdirSync(sb.stateDir, { recursive: true, encoding: 'utf8' })) {
      const p = join(sb.stateDir, f);
      if (!statSync(p).isFile()) continue;
      assert.equal(re.test(readFileSync(p, 'latin1')), false, `private content in ${f}`);
    }
  });
  it('uses only WHITELIST.telemetry keys in every event of both contours', () => {
    for (const e of [...events(sb, 'personal'), ...events(sb, 'corp')]) for (const k of Object.keys(e)) assert.ok(WHITELIST.telemetry.has(k as never), k);
  });
  it('holds the telemetry dir at 700 and both journals at 600', () => {
    assert.equal(statSync(sb.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(sb.stateDir, 'personal.jsonl')).mode & 0o777, 0o600);
    assert.equal(statSync(join(sb.stateDir, 'corp.jsonl')).mode & 0o777, 0o600);
  });
  it('re-emits a task-report only when its mtime changes', () => {
    decide(ctx(sb));
    assert.equal(events(sb, 'corp').filter((e) => e.event === 'task-report').length, 1);
    ageFile(join(fx.done, 'REPORT_SECRET_NAME.md'), -1);
    decide(ctx(sb));
    assert.equal(events(sb, 'corp').filter((e) => e.event === 'task-report').length, 2);
  });
});

describe('seed run', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('sets the offset to the file end for a file older than 24h and to zero for a live one — history is never imported', () => {
    const fx = layout(sb);
    appendFileSync(fx.corp, MSG_LINE(100, 0, 0, 100, 'OLD_HISTORY'));
    ageFile(fx.corp, 48);
    assert.equal(decide(ctx(sb)).kind, 'silent');
    assert.equal(events(sb, 'corp').length, 0); assert.equal(events(sb, 'personal').length, 0);
    assert.equal(offsetOf(sb, fx.corp), statSync(fx.corp).size);
    assert.equal(offsetOf(sb, fx.local), 0);
    appendFileSync(fx.corp, MSG_LINE(5, 0, 0, 3, 'NEW'));
    decide(ctx(sb));
    const ev = events(sb, 'corp');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].input_tokens, 5, 'history was imported into the accumulator');
  });
});

describe('cumulative semantics and tail reading', () => {
  const sb = sandbox(); let fx: Fx;
  before(() => { fx = layout(sb); decide(ctx(sb)); });
  after(() => sb.cleanup());

  it('emits the running total per session — the consumer takes the LAST event, the sum of events overstates', () => {
    appendFileSync(fx.local, MSG_LINE(3, 1, 2, 4, 'A'));
    decide(ctx(sb));
    appendFileSync(fx.local, MSG_LINE(7, 0, 1, 6, 'B'));
    decide(ctx(sb));
    const mine = events(sb, 'personal').filter((e) => e.executor === 'local-agent');
    assert.equal(mine.length, 2);
    assert.equal(mine[0].session, mine[1].session);
    assert.deepEqual([mine[1].input_tokens, mine[1].output_tokens], [10, 10]);
    assert.ok((mine[0].input_tokens as number) + (mine[1].input_tokens as number) > 10, 'the sum must overstate — that is why LAST is the rule');
  });
  it('advances the offset to the file end so the next run reads only the tail', () => {
    assert.equal(offsetOf(sb, fx.local), statSync(fx.local).size);
    const before = statSync(fx.local).size;
    appendFileSync(fx.local, MSG_LINE(1, 0, 0, 1, 'C'));
    const tail = readTail(fx.local, before)!;
    assert.equal(tail.lines.length, 1);
    assert.equal(tail.offset, statSync(fx.local).size);
  });
  it('does not advance past a tail without a newline and picks it up once completed', () => {
    const p = join(sb.dir, 'partial.jsonl');
    writeFileSync(p, MSG_LINE(1, 0, 0, 1, 'x') + '{"message":{"usage":{"input_tokens":9');
    const full = MSG_LINE(1, 0, 0, 1, 'x').length;
    const t1 = readTail(p, 0)!;
    assert.deepEqual([t1.lines.length, t1.offset], [1, full]);
    const t2 = readTail(p, full)!;
    assert.deepEqual([t2.lines.length, t2.offset], [0, full]);
    appendFileSync(p, ',"output_tokens":1}}}\n');
    const t3 = readTail(p, full)!;
    assert.equal(t3.lines.length, 1);
    assert.deepEqual(messageUsage(t3.lines[0]), { input_tokens: 9, cache_write: 0, cache_read: 0, output_tokens: 1 });
  });
  it('re-reads from zero when the file shrank below the stored offset — a replaced transcript is not a negative tail', () => {
    const p = join(sb.dir, 'shrunk.jsonl');
    writeFileSync(p, MSG_LINE(2, 0, 0, 2, 'y'));
    const t = readTail(p, 10_000)!;
    assert.equal(t.lines.length, 1);
    assert.equal(t.offset, statSync(p).size);
  });
  it('skips a corrupt line without stopping the parse and still moves the offset past it', () => {
    appendFileSync(fx.corp, '{"message":{"usage":{broken\n');
    appendFileSync(fx.corp, MSG_LINE(2, 0, 0, 2, 'ok'));
    decide(ctx(sb));
    assert.equal(offsetOf(sb, fx.corp), statSync(fx.corp).size);
    const ev = events(sb, 'corp');
    assert.equal(ev.length, 1); assert.equal(ev[0].input_tokens, 2);
  });
  it('returns null from both line parsers for lines without a usage object and for non-JSON', () => {
    assert.equal(codexUsage('{"payload":{"info":{}}}'), null);
    assert.equal(codexUsage('not json "total_token_usage"'), null);
    assert.equal(messageUsage('{"message":{"content":"\\"usage\\" as text only"}}'), null);
    assert.equal(messageUsage('{"other":1}'), null);
    assert.deepEqual(codexUsage(CODEX_LINE(6, 2, 2).trim()), { input_tokens: 6, cache_write: 0, cache_read: 2, output_tokens: 2 });
  });
  it('returns null for a missing file rather than throwing', () => {
    assert.equal(readTail(join(sb.dir, 'nope.jsonl'), 0), null);
  });
});

describe('parallel sessions', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('produces exactly one event per transcript when 8 Stop hooks run at once — offsets move under one lock', () => {
    const fx = layout(sb); decide(ctx(sb));
    appendFileSync(fx.local, MSG_LINE(3, 1, 2, 4, 'P'));
    appendFileSync(fx.codex, CODEX_LINE(6, 2, 2));
    const script = join(sb.dir, 'stop.ts');
    writeFileSync(script, `import { decide } from '${HARNESS_ROOT}/src/telemetry.ts';\nconst v = decide({ event: 'stop', payload: { session_id: 's', cwd: '/tmp', hook_event_name: 'Stop' } as never, env: { HOME: process.argv[2], CLAUDE_STATE_DIR: process.argv[3] }, root: '${HARNESS_ROOT}', stateDir: process.argv[3], now: Date.now });\nconsole.log(v.kind);`);
    const r = spawnSync('sh', ['-c', `for i in $(seq 1 8); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" "${sb.home}" "${sb.stateDir}" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/silent/g) ?? []).length, 8, r.stdout + r.stderr);
    const ev = events(sb, 'personal');
    assert.equal(ev.filter((e) => e.executor === 'local-agent').length, 1, JSON.stringify(ev));
    assert.equal(ev.filter((e) => e.executor === 'codex').length, 1, JSON.stringify(ev));
  });
});

describe('horizon', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('drops state rows of a transcript that left the horizon and ignores it while it stays there', () => {
    const fx = layout(sb); decide(ctx(sb));
    appendFileSync(fx.corp, MSG_LINE(5, 0, 0, 3, 'h'));
    decide(ctx(sb));
    assert.equal(events(sb, 'corp').length, 1);
    ageFile(fx.corp, 72);
    decide(ctx(sb, { TELEMETRY_HORIZON_DAYS: '1' }));
    assert.equal(offsetOf(sb, fx.corp), null, 'state row for a file beyond the horizon must be pruned');
    assert.equal(events(sb, 'corp').length, 1);
  });
});

describe('unknown and kill-switch', () => {
  it('answers unknown with a reason when HOME is absent — roots cannot be resolved, silence would hide it', () => {
    const sb = sandbox();
    const v = decide(ctx(sb, { HOME: undefined }));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /HOME/);
    sb.cleanup();
  });
  it('stays silent when none of the roots exist — an absent Codex or corp checkout is a normal machine', () => {
    const sb = sandbox();
    assert.equal(decide(ctx(sb)).kind, 'silent');
    assert.equal(decide(ctx(sb)).kind, 'silent');
    assert.equal(events(sb, 'personal').length + events(sb, 'corp').length, 0);
    sb.cleanup();
  });
  it('does nothing at all under CLAUDE_SKIP_AI_USAGE=1 through route(): silent verdict, no journals, no seed marker, no telemetry rows', async () => {
    const sb = sandbox(); const fx = layout(sb);
    appendFileSync(fx.codex, CODEX_LINE(6, 2, 2));
    const v = await route('stop', payload('Stop') as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, ...onlyGate('telemetry'), [KILL_SWITCH]: '1' });
    assert.equal(v.kind, 'silent');
    // Другие гейты события stop могут открыть harness.db — проверяется след ИМЕННО этого гейта.
    assert.equal(readdirSync(sb.stateDir).some((f) => f.endsWith('.jsonl')), false, 'journal written under kill-switch');
    if (existsSync(join(sb.stateDir, 'harness.db'))) {
      const st = State.open(sb.stateDir);
      try {
        assert.equal(st.marker('telemetry.seeded'), null, 'seed marker written under kill-switch');
        assert.equal((st.db.prepare('SELECT count(*) c FROM telemetry_offsets').get() as { c: number }).c, 0);
        assert.equal((st.db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='telemetry_files'").get() as { c: number }).c, 0, 'own table created under kill-switch');
      } finally { st.close(); }
    }
    sb.cleanup();
  });
});
