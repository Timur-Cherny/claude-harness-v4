// INVARIANT R8: единственная вендоренная зависимость — SQL-парсер; каждый файл совпадает с VENDOR.lock по sha256.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../scripts/vendor.ts';
import { HARNESS_ROOT } from '../_env.ts';

describe('vendor', () => {
  const lock = JSON.parse(readFileSync(join(HARNESS_ROOT, 'VENDOR.lock'), 'utf8')) as { package: string; version: string; files: Record<string, string> };
  it('has every vendored file byte-identical to the lock', () => {
    for (const [f, sum] of Object.entries(lock.files)) assert.equal(sha256(join(HARNESS_ROOT, f)), sum, f);
  });
  it('contains no vendored file outside the lock — an unlisted file is an undeclared dependency', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const present = walk(join(HARNESS_ROOT, 'vendor')).map((p) => p.slice(HARNESS_ROOT.length + 1)).sort();
    assert.deepEqual(present, Object.keys(lock.files).sort());
  });
  it('pins the package identity', () => { assert.equal(lock.package, '@supabase/pg-parser'); assert.match(lock.version, /^\d+\.\d+\.\d+$/); });
});
