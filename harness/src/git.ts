// Единственная точка обращения к git: только read-глаголы (I2). fetch — отдельная функция с явным именем,
// чтобы lint-тест видел его как единственное исключение. Всегда --no-optional-locks: сверка бежит рядом
// с чужими `git add`, и не имеет права ждать index.lock.
import { spawnTool } from './platform.ts';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const READ_VERBS = new Set(['status', 'diff', 'diff-index', 'rev-parse', 'ls-files', 'log', 'show', 'rev-list', 'merge-base', 'branch', 'cat-file', 'config', 'for-each-ref', 'remote']);

export function git(cwd: string, args: string[], timeoutMs = 8000): { rc: number; stdout: string; stderr: string } {
  const verb = args.find((a) => !a.startsWith('-')) ?? '';
  if (!READ_VERBS.has(verb)) throw new Error(`git: глагол «${verb}» вне allowlist чтения`);
  if (verb === 'config' && !args.includes('--get') && !args.includes('--get-all')) throw new Error('git config: только --get');
  return spawnTool('git', ['--no-optional-locks', ...args], { cwd, timeoutMs });
}

export function toplevel(cwd: string): string | null {
  try { if (!statSync(cwd).isDirectory()) return null; } catch { return null; }
  const r = git(cwd, ['rev-parse', '--show-toplevel'], 3000);
  return r.rc === 0 ? r.stdout.trim() : null;
}

export function head(repo: string): string | null {
  const r = git(repo, ['rev-parse', 'HEAD'], 3000);
  return r.rc === 0 ? r.stdout.trim() : null;
}

export interface StatusEntry { xy: string; path: string }

/** `git status --porcelain -z -uall`: -uall обязателен (без него новый каталог схлопывается в одну строку `?? dir/`). */
export function status(repo: string): StatusEntry[] | null {
  const r = git(repo, ['status', '--porcelain', '-z', '-uall'], 15000);
  if (r.rc !== 0) return null;
  const out: StatusEntry[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2); const path = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // вторая запись — старое имя
    out.push({ xy, path });
  }
  return out;
}

export function diffNames(repo: string, from: string, to: string): string[] {
  const r = git(repo, ['diff', '--name-only', `${from}..${to}`], 8000);
  return r.rc === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

export function gitDirMtime(repo: string): number {
  try { return statSync(join(repo, '.git')).mtimeMs; } catch { return 0; }
}
