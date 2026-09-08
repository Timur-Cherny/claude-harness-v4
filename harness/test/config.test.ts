// Молча ломалось: сайт-специфика (защищённая ветка, репозитории конвенции, путь вольта) жила в исходниках,
// поэтому контур нельзя было поставить на чужую машину, не раздав состав работодателя, а «обобщить» его
// можно было только форком.
// INVARIANT: нет конфига — дженерик-дефолты и тишина там, где поведение бессмысленно без настройки.
// INVARIANT: битый конфиг не роняет событие — конфиг описывает удобство, падать из-за него дороже.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './_env.ts';
import { loadConfig, configPath, resetConfigCache } from '../src/config.ts';

function withFile(content: string | null, where: 'home' | 'explicit'): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const sb = sandbox('harness-config-');
  const path = where === 'home' ? join(sb.home, '.claude', 'harness.config.json') : join(sb.dir, 'explicit.json');
  if (content !== null) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  resetConfigCache();
  const env: NodeJS.ProcessEnv = where === 'home' ? { HOME: sb.home } : { HOME: sb.home, CLAUDE_HARNESS_CONFIG: path };
  return { env, cleanup: () => { sb.cleanup(); resetConfigCache(); } };
}

describe('config', () => {
  it('protects main and nothing else when no config file exists', () => {
    const c = withFile(null, 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['main']);
    assert.equal(cfg.workDocs, undefined);
    assert.equal(cfg.vaultRel, undefined);
    c.cleanup();
  });

  it('reads protected branches, the work-docs convention and the vault path from the file', () => {
    const c = withFile(JSON.stringify({ protectedBranches: ['product/main', 'main'], workDocs: { cwd: 'foo', text: 'bar' }, vaultRel: 'Docs/vault' }), 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['product/main', 'main']);
    assert.deepEqual(cfg.workDocs, { cwd: 'foo', text: 'bar' });
    assert.equal(cfg.vaultRel, 'Docs/vault');
    c.cleanup();
  });

  it('falls back to the defaults on broken JSON instead of throwing on every event', () => {
    const c = withFile('{ not json', 'home');
    assert.deepEqual(loadConfig(c.env).protectedBranches, ['main']);
    c.cleanup();
  });

  it('ignores fields of the wrong shape rather than trusting them into a gate', () => {
    const c = withFile(JSON.stringify({ protectedBranches: 'main', workDocs: { cwd: 'foo' }, vaultRel: 42 }), 'home');
    const cfg = loadConfig(c.env);
    assert.deepEqual(cfg.protectedBranches, ['main'], 'строка вместо массива — это не список веток');
    assert.equal(cfg.workDocs, undefined, 'workDocs без text бесполезен: напоминать нечем');
    assert.equal(cfg.vaultRel, undefined);
    c.cleanup();
  });

  it('drops empty entries and an empty list rather than protecting a branch named ""', () => {
    const c = withFile(JSON.stringify({ protectedBranches: ['', ''] }), 'home');
    assert.deepEqual(loadConfig(c.env).protectedBranches, ['main']);
    c.cleanup();
  });

  it('lets CLAUDE_HARNESS_CONFIG outrank the path under HOME', () => {
    const c = withFile(JSON.stringify({ protectedBranches: ['trunk'] }), 'explicit');
    assert.deepEqual(loadConfig(c.env).protectedBranches, ['trunk']);
    assert.equal(configPath(c.env), c.env.CLAUDE_HARNESS_CONFIG);
    c.cleanup();
  });

  it('has no config path at all when HOME is unset — no read, no default file', () => {
    resetConfigCache();
    assert.equal(configPath({}), null);
    assert.deepEqual(loadConfig({}).protectedBranches, ['main']);
  });
});
