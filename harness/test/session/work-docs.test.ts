// Молча ломалось бы: важное объяснение поведения системы оставалось в чате, не доезжая до вольта.
// INVARIANT: напоминание только в настроенных репозиториях и только при документном намерении; вне них —
// тишина даже при совпадении слов; промпт без поля prompt внутри — unknown, не тишина.
// INVARIANT (переносимость): площадка живёт в конфиге, а не в коде. Конфига нет — гейт молчит на любом
// промпте, поэтому контур ставится на чужую машину, не таща за собой чужие имена репозиториев и путь вольта.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { decide, KILL, NAME } from '../../src/session/work-docs.ts';
import { resetConfigCache } from '../../src/config.ts';
import { route } from '../../src/main.ts';
import type { GateContext } from '../../src/types.ts';

const REPO = '/Users/x/work/shop-api';
const TEXT = 'зафиксируй объяснение как work-doc в вольте, не только в чате';

/** Песочница с конфигом площадки; без аргумента — конфига нет вовсе. */
function withConfig(cfg?: unknown): { home: string; cleanup: () => void } {
  const sb = sandbox('harness-workdocs-');
  if (cfg !== undefined) {
    mkdirSync(join(sb.home, '.claude'), { recursive: true });
    writeFileSync(join(sb.home, '.claude', 'harness.config.json'), JSON.stringify(cfg));
  }
  resetConfigCache();
  return { home: sb.home, cleanup: () => { sb.cleanup(); resetConfigCache(); } };
}

const CONFIGURED = { workDocs: { cwd: '(shop-api|shop-web|shop-worker)', text: TEXT } };

function ctxFor(home: string, cwd: string, extra: Record<string, unknown>): GateContext {
  return { event: 'prompt', payload: payload('UserPromptSubmit', extra, cwd) as never, env: { HOME: home }, root: HARNESS_ROOT, stateDir: '/tmp/none/state', now: Date.now };
}

describe(NAME, () => {
  it('injects the configured reminder for each documentation intent — Cyrillic upper case included', () => {
    const c = withConfig(CONFIGURED);
    for (const p of ['задокументируй, как коннектор шлёт статусы', 'Опиши для бизнеса, как РАБОТАЕТ резерв', 'как устроен return-gate?', 'положи это в vault', 'нужен work-doc по outbox', 'запиши в память про документ', 'ворк-док по стадиям']) {
      const v = decide(ctxFor(c.home, REPO, { prompt: p }));
      assert.equal(v.kind, 'context', p);
      assert.equal((v as { text: string }).text, TEXT);
    }
    c.cleanup();
  });

  it('stays silent without the intent, matches every configured repo name and stays silent outside them', () => {
    const c = withConfig(CONFIGURED);
    for (const p of ['поправь тест на резерв', 'запусти сборку', 'что в логах пода?']) assert.equal(decide(ctxFor(c.home, REPO, { prompt: p })).kind, 'silent', p);
    for (const cwd of ['/w/shop-web/src', '/w/shop-worker']) assert.equal(decide(ctxFor(c.home, cwd, { prompt: 'задокументируй' })).kind, 'context', cwd);
    assert.equal(decide(ctxFor(c.home, '/Users/x/other-project', { prompt: 'задокументируй как работает всё' })).kind, 'silent');
    c.cleanup();
  });

  it('answers unknown when the payload carries no prompt inside a configured repo, and silent outside it', () => {
    const c = withConfig(CONFIGURED);
    const v = decide(ctxFor(c.home, REPO, {}));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /prompt/);
    assert.equal(decide(ctxFor(c.home, '/Users/x/other', {})).kind, 'silent');
    c.cleanup();
  });

  it('stays silent on a machine with no config at all — a fresh install carries no foreign convention', () => {
    const c = withConfig();
    assert.equal(decide(ctxFor(c.home, REPO, { prompt: 'задокументируй как работает резерв' })).kind, 'silent');
    c.cleanup();
  });

  it('stays silent when the configured cwd pattern is a broken regex instead of throwing on every prompt', () => {
    const c = withConfig({ workDocs: { cwd: '([unclosed', text: TEXT } });
    assert.equal(decide(ctxFor(c.home, REPO, { prompt: 'задокументируй' })).kind, 'silent');
    c.cleanup();
  });

  it('is skipped by its kill-switch through route()', async () => {
    const sb = sandbox('harness-workdocs-kill-');
    mkdirSync(join(sb.home, '.claude'), { recursive: true });
    writeFileSync(join(sb.home, '.claude', 'harness.config.json'), JSON.stringify(CONFIGURED));
    resetConfigCache();
    const v = await route('prompt', payload('UserPromptSubmit', { prompt: 'задокументируй' }, REPO) as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, [KILL]: '1', CLAUDE_SKIP_GIT_FRESHNESS: '1' });
    assert.equal(v.kind, 'silent');
    sb.cleanup();
    resetConfigCache();
  });
});
