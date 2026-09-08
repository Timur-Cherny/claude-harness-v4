// Общая обвязка тестов. INVARIANT I7: тесты не касаются реального ~/.claude — каждый тест получает
// временные HOME и CLAUDE_STATE_DIR; помощник отказывается работать с путём под настоящим домом.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HARNESS_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
export const NODE_BIN = process.execPath;

// TypeScript адресуется пином CLAUDE_HARNESS_TS (его пишет install.sh), иначе — резолвом из окружения
// запуска. Жёсткого пути к машине автора здесь нет: он делал сьют непереносимым и уезжал в дистрибутив.
// Не нашли — пустая строка: проверки содержимого ответят unknown, и это видно в тесте, а не молча.
export const TS_PATH = process.env.CLAUDE_HARNESS_TS ?? (() => {
  try { return createRequire(import.meta.url).resolve('typescript/lib/typescript.js'); } catch { return ''; }
})();

import { GATES } from '../src/gates/registry.ts';
const REAL_HOME = realpathSync(homedir());

export function assertNotReal(p: string): void {
  const rp = (() => { try { return realpathSync(p); } catch { return p; } })();
  if (rp === REAL_HOME || rp.startsWith(REAL_HOME + '/.claude')) throw new Error(`тест пытается использовать реальный путь: ${p}`);
}

export interface Sandbox { home: string; stateDir: string; dir: string; cleanup: () => void }

export function sandbox(prefix = 'harness-test-'): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, 'home'); const stateDir = join(dir, 'state');
  mkdirSync(home, { recursive: true }); mkdirSync(stateDir, { recursive: true });
  assertNotReal(home); assertNotReal(stateDir);
  return { home, stateDir, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface HookRun { rc: number; stdout: string; stderr: string; json: unknown | null }

/** Чёрный ящик: bin/hook <event> с payload на stdin и заданным окружением. */
export function runHook(event: string, payload: unknown, sb: Sandbox, env: Record<string, string> = {}, opts: { path?: string } = {}): HookRun {
  assertNotReal(sb.home);
  const r = spawnSync('sh', [join(HARNESS_ROOT, 'bin', 'hook'), event], {
    input: payload === null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { PATH: opts.path ?? '/usr/bin:/bin', HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, ...env },
    timeout: 20000,
  });
  let json: unknown | null = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { json = null; }
  return { rc: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
}

/** Поддельный бинарь node: печатает версию на `-v`, иначе записывает argv в файл и выходит 0. */
export function fakeNode(dir: string, version: string, recordTo?: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'node');
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "v${version}"; exit 0; fi\n${recordTo ? `printf '%s\\n' "v${version}" "$@" >> '${recordTo}'\ncat >/dev/null\n` : ''}exit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

export function payload(event: string, extra: Record<string, unknown> = {}, cwd = '/tmp'): Record<string, unknown> {
  return { session_id: 'session-1', prompt_id: 'p-1', cwd, permission_mode: 'auto', hook_event_name: event, ...extra };
}

export function bashPayload(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return payload('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1', ...extra });
}

// Выключатели всех ЧУЖИХ гейтов. Тест через route() обязан доказывать вклад ОДНОГО модуля:
// merge() отдаёт сильнейший вердикт всего события, поэтому без изоляции подключение нового
// гейта красит чужой тест (случай 05.09 — четыре теста после подключения реестра).
// Гейты, делящие выключатель с проверяемым (memory-frontmatter/memory-index), не гасятся.
export function onlyGate(keep: string): Record<string, string> {
  if (!GATES.length) throw new Error('onlyGate вызван до импорта src/main.ts — реестр пуст, изоляция была бы мнимой');
  const own = GATES.find((g) => g.name === keep)?.killSwitch;
  if (!own) throw new Error(`onlyGate: гейт ${keep} не зарегистрирован`);
  const env: Record<string, string> = {};
  for (const g of GATES) if (g.killSwitch !== own) env[g.killSwitch] = '1';
  return env;
}
