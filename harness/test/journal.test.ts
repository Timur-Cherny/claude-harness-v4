// INVARIANT I3/I6: в журнал уходят только объявленные поля-метки; параллельные писатели не рвут строки.
// Молча ломалось: friction-raw.jsonl месяцами хранил поля, выведенные из содержимого отчётов.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, assertWhitelisted, JournalError } from '../src/journal.ts';
import { sandbox, NODE_BIN, HARNESS_ROOT } from './_env.ts';

describe('assertWhitelisted', () => {
  it('rejects a field outside the journal whitelist — a new field must be declared on purpose', () => {
    assert.throws(() => assertWhitelisted('friction', { ts: 'x', report_body: 'секрет' }), JournalError);
  });
  it('rejects a whitelisted field whose value looks like a path or a text — labels only', () => {
    assert.throws(() => assertWhitelisted('friction', { ts: 'x', agent_type: '/Users/someone/secret/file.ts' }), /путь или текст/);
    assert.throws(() => assertWhitelisted('friction', { ts: 'x', missing_reason: 'a'.repeat(201) }), /путь или текст/);
  });
  it('accepts a record made only of declared label fields', () => {
    assert.doesNotThrow(() => assertWhitelisted('friction', { ts: '2026-09-05T00:00:00Z', scope: 'module', trace_kind: 'constraint', files_changed: 3 }));
  });
});

describe('appendJsonl', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('keeps every line whole and countable under 24 concurrent appenders', () => {
    const script = join(sb.dir, 'w.ts'); const out = join(sb.stateDir, 'j.jsonl');
    writeFileSync(script, `import { appendJsonl } from '${HARNESS_ROOT}/src/journal.ts';\nfor (let i = 0; i < 20; i++) appendJsonl(process.argv[2], 'friction', { ts: 't', scope: 'function', trace_kind: 'rule', files_changed: i, missing_reason: 'x'.repeat(150) });`);
    const r = spawnSync('sh', ['-c', `for i in $(seq 1 24); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" "${out}" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 24 * 20);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), l.slice(0, 80));
  });
});
