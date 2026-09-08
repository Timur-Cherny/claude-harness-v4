// INVARIANT: список слов-триггеров один — bin/prefilter.regex (для шима) равен экспорту prefilters.ts (для роутера).
// Молча ломалось бы: шим отсекает команду, которую роутер считает опасной, или наоборот.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prefilterSource, PRE_BASH_REGEX } from '../../src/gates/prefilters.ts';
import { HARNESS_ROOT } from '../_env.ts';

describe('prefilter', () => {
  it('keeps bin/prefilter.regex byte-equal to prefilters.ts', () => {
    assert.equal(readFileSync(join(HARNESS_ROOT, 'bin', 'prefilter.regex'), 'utf8'), prefilterSource() + '\n');
  });
  it('matches the guarded commands and passes plain ones (both sides)', () => {
    for (const c of ["kubectl exec p -- psql -c 'x'", 'git -C /r push origin', 'cd x && git commit -m a', 'npx jest --runTestsByPath x', 'docker compose up -d', 'PGPASSWORD=1 pg_dump db']) assert.ok(PRE_BASH_REGEX.test(c), c);
    for (const c of ['ls -la', 'echo hi && cat file', 'git status --porcelain', 'grep -n foo bar.ts', 'node --test']) assert.equal(PRE_BASH_REGEX.test(c), false, c);
  });
});
