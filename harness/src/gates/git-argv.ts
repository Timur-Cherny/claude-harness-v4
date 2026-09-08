// Разбор git-вызова по argv токенизатора — не по тексту команды: глобальные опции до глагола
// (`-C <path>`, `-c k=v`, `--git-dir=…`) и эффективный cwd сегмента с учётом предшествующих `cd`.
// Так `cd X && git push` и `git -C X push` видны как push в каталоге X, а не в cwd сессии.
// Regex здесь один — форма `$VAR`/`${VAR}` для подстановки из окружения; переменная без значения
// делает cwd неизвестным (null), и гейт обязан ответить unknown, а не угадать каталог.
import { resolve, isAbsolute } from 'node:path';
import { commands, type ShellParse } from '../parsers/shell.ts';

export interface SegmentAt { name: string; argv: string[]; rest: string[]; raw: string; depth: number; cwd: string | null; heredocs: string[]; unknown: string[] }
export interface GitCall { verb: string; args: string[]; cwd: string | null }

const GLOBAL_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--list-cmds', '--attr-source']);

export function expandWord(word: string, env: NodeJS.ProcessEnv): string | null {
  let missing = false;
  let out = word;
  if (out === '~' || out.startsWith('~/')) { if (env.HOME === undefined) return null; out = env.HOME + out.slice(1); }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const v = env[(a ?? b) as string];
    if (v === undefined) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

function step(cur: string | null, word: string, env: NodeJS.ProcessEnv): string | null {
  const e = expandWord(word, env);
  if (e === null) return null;
  if (isAbsolute(e)) return e;
  return cur === null ? null : resolve(cur, e);
}

/** Сегменты с их эффективным cwd: `cd`/`pushd` сдвигают каталог для всех последующих сегментов. */
export function segmentsWithCwd(parse: ShellParse, cwd: string, env: NodeJS.ProcessEnv): SegmentAt[] {
  let cur: string | null = cwd;
  const out: SegmentAt[] = [];
  for (const c of commands(parse)) {
    const seg = parse.segments[out.length];
    out.push({ name: c.name, argv: c.argv, rest: c.rest, raw: seg?.raw ?? c.argv.join(' '), depth: c.depth, cwd: cur, heredocs: seg?.heredocs ?? [], unknown: seg?.unknown ?? [] });
    if (c.name !== 'cd' && c.name !== 'pushd') continue;
    if (c.rest.includes('-')) { cur = null; continue; }               // cd - → OLDPWD, неизвестен
    const arg = c.rest.find((a) => !a.startsWith('-'));
    cur = arg === undefined ? (env.HOME ?? null) : step(cur, arg, env);
  }
  return out;
}

/** Глагол git и его аргументы после глобальных опций; `-C <path>` сдвигает cwd вызова. */
export function parseGit(rest: string[], cwd: string | null, env: NodeJS.ProcessEnv): GitCall | null {
  let cur = cwd;
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (!a.startsWith('-')) return { verb: a, args: rest.slice(i + 1), cwd: cur };
    if (a === '-C') { const p = rest[i + 1]; if (p === undefined) return null; cur = step(cur, p, env); i += 2; continue; }
    if (GLOBAL_WITH_VALUE.has(a)) { i += 2; continue; }
    i++; // -p, --no-pager, --bare, --foo=bar
  }
  return null;
}

export function isGit(name: string): boolean { return (name.split('/').pop() ?? name) === 'git'; }
