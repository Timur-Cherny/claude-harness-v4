// Ярус воркера: tsc --noEmit проекта по ближайшему tsconfig.json (порт hooks/changed-file-check.sh:97-111).
// Мемо — по хешу СОДЕРЖИМОГО всего набора изменённых .ts проекта (правка файла B ломает A: A перепроверяется).
// Бинарь tsc — проектный (node_modules/.bin/tsc под PATH сессии), не харнесс-Node: проверяется то, что собирает проект.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnTool } from '../platform.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult } from './types.ts';

export function tsProject(file: ChangedFile): string | null {
  let d = dirname(file.absPath);
  while (d.length >= file.repo.length) {
    if (existsSync(join(d, 'tsconfig.json'))) return d;
    if (d === file.repo) break;
    d = dirname(d);
  }
  return null;
}

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && /\.(ts|tsx|mts|cts)$/.test(file.path) && !/\.d\.ts$/.test(file.path) && tsProject(file) !== null; }

export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  const proj = tsProject(file);
  if (!proj) return { verdict: 'unknown', missing_reason: 'tsconfig.json не найден' };
  // Только проектный бинарь: `npx tsc` может подхватить чужой глобальный пакет (на этой машине — заглушка «This is not the tsc command»).
  const local = [join(proj, 'node_modules', '.bin', 'tsc'), join(file.repo, 'node_modules', '.bin', 'tsc')].find(existsSync);
  if (!local) return { verdict: 'unknown', missing_reason: 'tsc не установлен в проекте (node_modules отсутствует)' };
  const r = spawnTool('node', [local, '--noEmit', '-p', proj], { cwd: proj, timeoutMs: Math.min(ctx.deadlineMs, 600000), env: ctx.env });
  if (r.rc === 124) return { verdict: 'unknown', missing_reason: 'tsc превысил таймаут' };
  if (r.rc !== 0) return { verdict: 'fail', message: `${file.path}: tsc\n${(r.stdout + r.stderr).trim().split('\n').slice(0, 12).join('\n')}`.slice(0, 4096) };
  return { verdict: 'pass' };
}

registerChecker({ name: 'tsc-project', tier: 'worker', killSwitch: 'CLAUDE_SKIP_CHECK', applies, run });
