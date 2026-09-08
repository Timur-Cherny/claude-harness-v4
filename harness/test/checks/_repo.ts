// Временный git-репозиторий для проверок файла: коммит базы, правка, сборка ChangedFile/CheckContext.
// Тесты никогда не касаются реального ~/.claude (I7): HOME — из sandbox, системный gitconfig отключён.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Sandbox } from '../_env.ts';
import type { ChangedFile, CheckContext } from '../../src/checks/types.ts';

// Путь к typescript — один на весь сьют, в _env.ts: пин или резолв, без жёсткого пути к машине автора.
export { TS_PATH } from '../_env.ts';
import { TS_PATH } from '../_env.ts';

export interface Repo { root: string; git: (...args: string[]) => string; write: (rel: string, text: string) => string; commitAll: (msg?: string) => void }

export function initRepo(sb: Sandbox, name = 'repo'): Repo {
  const root = join(sb.dir, name);
  mkdirSync(root, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q');
  const write = (rel: string, text: string): string => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return abs;
  };
  const commitAll = (msg = 'base'): void => { git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg); };
  return { root, git, write, commitAll };
}

export function changed(repo: Repo, rel: string, status: ChangedFile['status'] = 'M'): ChangedFile {
  const absPath = join(repo.root, rel);
  const digest = createHash('sha256').update(readFileSync(absPath)).digest('hex').slice(0, 16);
  return { repo: repo.root, path: rel, absPath, digest, status };
}

export function ctx(sb: Sandbox, env: Record<string, string> = { CLAUDE_HARNESS_TS: TS_PATH }): CheckContext {
  return { env, stateDir: sb.stateDir, now: Date.now, deadlineMs: 10000 };
}
