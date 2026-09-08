// Временные git-репозитории для тестов сборщиков сессии. Настоящий git, но только в sandbox.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Личность коммитера задаётся явно. Иначе git берёт её из окружения машины: на macOS он выводит
// user@host из gecos и коммитит с предупреждением, в чистом контейнере — отказывается («Committer identity
// unknown»), и репозиторий БЕЗ user.email (кейс атрибуции) создаётся только на одной из двух систем.
// Авторство не трогаем: гейт фильтрует `git log --author=<user.email>`, и подмена автора сломала бы смысл.
const COMMITTER = { GIT_COMMITTER_NAME: 'FIXTURE', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

export function sh(cwd: string, bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...COMMITTER } });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} → rc ${r.status}\n${r.stderr}`);
  return r.stdout;
}

export function initRepo(dir: string, opts: { email?: string | null; name?: string; branch?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', opts.branch ?? 'main']);
  if (opts.email !== null) sh(dir, 'git', ['config', 'user.email', opts.email ?? 'test@example.invalid']);
  sh(dir, 'git', ['config', 'user.name', opts.name ?? 'TEST']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  return dir;
}

export function commit(dir: string, file: string, content: string, msg = 'test commit', author?: string): string {
  writeFileSync(join(dir, file), content);
  sh(dir, 'git', ['add', file]);
  const args = ['commit', '-q', '-m', msg];
  if (author) args.push(`--author=${author}`);
  sh(dir, 'git', args);
  return sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
}

export function headShort(dir: string): string { return sh(dir, 'git', ['rev-parse', '--short', 'HEAD']).trim(); }
