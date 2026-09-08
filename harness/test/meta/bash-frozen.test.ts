// INVARIANT I10: двуязычие невозможно процессно — оставшиеся bash-хуки заморожены по sha256 (правка → провал,
// удаление → норма), список .sh/.py в hooks/ и scripts/ только сжимается. Замок — harness/BASH_FROZEN.lock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync as fsReaddir } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../_env.ts';

const REPO = join(HARNESS_ROOT, '..');
const lock = JSON.parse(readFileSync(join(HARNESS_ROOT, 'BASH_FROZEN.lock'), 'utf8')) as Record<string, string>;

describe('bash-frozen', () => {
  it('every remaining bash/python file of the contour is byte-identical to the lock or gone — never edited', () => {
    for (const [f, sum] of Object.entries(lock)) {
      const p = join(REPO, f);
      if (!existsSync(p)) continue; // удалён — норма миграции
      assert.equal(createHash('sha256').update(readFileSync(p)).digest('hex'), sum, `${f} изменён: bash заморожен, правки — только в harness/src`);
    }
  });
  it('lists no bash/python contour file that is absent from the lock — a new .sh/.py is a regression of К5', () => {
    const readdirSync = fsReaddir;
    const present = ['hooks', 'hooks/spec', 'scripts', '.claude'].flatMap((d) => { const dir = join(REPO, d); return existsSync(dir) ? readdirSync(dir).filter((n) => /\.(sh|py)$/.test(n)).map((n) => `${d}/${n}`) : []; });
    const unlisted = present.filter((f) => !(f in lock) && !ALLOW_NEW.has(f));
    assert.deepEqual(unlisted, []);
  });
});
const ALLOW_NEW = new Set<string>([]);
