// INVARIANT К5/R6: каждая команда в settings.v4.json — bin/hook <известное событие>; ни одного прямого пути к .sh;
// матчер MCP — regex `mcp__.*` (голое `mcp__` — точное имя и не совпадает ни с чем: проба 05.09); поле `if` не используется (не фильтрует).
//
// INVARIANT I10 (живой файл): проверялись только ШАБЛОНЫ — settings.v4.json и settings.repo.v4.json. Файл, который
// решает, что запустится (корневой settings.json, симлинк ~/.claude/settings.json), не проверялся ничем, и контур
// молча остался двуязычным: 19 bash-хуков v2/v3 подключены, ни одного bin/hook. bash-frozen.test.ts запрещает bash
// ПРАВИТЬ, но не ИСПОЛНЯТЬ. Проверка обязана висеть на исполняемом файле, а не на образце рядом с ним.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../_env.ts';

const KNOWN = new Set(['pre-bash', 'pre-agent', 'pre-write', 'post', 'post-batch', 'agent-start', 'agent-stop', 'stop', 'session-start', 'session-end', 'prompt', 'precompact', 'worktree-create', 'worktree-remove', 'contour-changed']);
type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number; if?: string }> }>>;

const REPO = join(HARNESS_ROOT, '..');
const HOOK_SHIM = '"$HOME"/.claude/harness/bin/hook ';

// Шаблоны cut-over и живой файл рядом: расхождение между ними и есть тот разрыв, который держался незамеченным.
const TARGETS = [
  { file: 'settings.v4.json', path: join(HARNESS_ROOT, 'settings.v4.json'), prefix: HOOK_SHIM },
  { file: 'settings.repo.v4.json', path: join(HARNESS_ROOT, 'settings.repo.v4.json'), prefix: '"$CLAUDE_PROJECT_DIR"/.claude/bin/hook ' },
  { file: 'settings.json (живой user-level)', path: join(REPO, 'settings.json'), prefix: HOOK_SHIM },
  { file: '.claude/settings.json (живой repo-level)', path: join(REPO, '.claude/settings.json'), prefix: '"$CLAUDE_PROJECT_DIR"/.claude/bin/hook ' },
] as const;

for (const { file, path, prefix } of TARGETS) {
  describe(file, () => {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Hooks };
    const entries = Object.entries(cfg.hooks).flatMap(([ev, arr]) => arr.flatMap((m) => m.hooks.map((h) => ({ ev, matcher: m.matcher, ...h }))));
    it('routes every command through the shim with a known event and a timeout', () => {
      assert.ok(entries.length > 0, 'блок hooks пуст — контур не подключён вообще');
      for (const e of entries) {
        assert.equal(e.type, 'command');
        assert.ok(e.command.startsWith(prefix), e.command);
        assert.ok(KNOWN.has(e.command.slice(prefix.length)), e.command);
        assert.ok(typeof e.timeout === 'number' && e.timeout > 0, e.command);
        assert.equal(e.if, undefined, 'поле if не фильтрует — префильтр в шиме');
      }
    });
    it('names no bash hook in the wired block — bilingualism is impossible by process, not by intent', () => {
      // Только блок hooks: в autoMode.* лежит проза, легитимно называющая чужие .sh (pull-prod-config.sh).
      const wired = JSON.stringify(cfg.hooks);
      assert.equal(wired.match(/[^"/ ]+\.(sh|py)/g), null, 'в подключённом блоке остались bash/python-хуки: контур двуязычен');
    });
    it('uses a regex matcher for MCP tools and never a bare mcp__', () => {
      for (const e of entries) if (e.matcher?.startsWith('mcp')) assert.equal(e.matcher, 'mcp__.*');
    });
    it('gives resource-heavy pre-bash a timeout above the 240 s wait window', () => {
      for (const e of entries.filter((x) => x.command.endsWith(' pre-bash'))) assert.ok((e.timeout ?? 0) >= 300, 'pre-bash ждёт окно до 240 с — таймаут обязан быть больше');
    });
  });
}

describe('settings.v4.json ↔ settings.json', () => {
  it('keeps the live user-level file identical to the cut-over template it is generated from', () => {
    // Шаблон существует ровно для того, чтобы его применили. Разошлись — значит cut-over выполнен наполовину.
    const tpl = JSON.parse(readFileSync(join(HARNESS_ROOT, 'settings.v4.json'), 'utf8')) as { hooks: Hooks };
    const live = JSON.parse(readFileSync(join(REPO, 'settings.json'), 'utf8')) as { hooks: Hooks };
    assert.deepEqual(live.hooks, tpl.hooks, 'блок hooks живого settings.json разошёлся с settings.v4.json');
  });
});
