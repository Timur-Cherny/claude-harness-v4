// Добавленные строки файла относительно HEAD (нового файла — все): единственный источник «только новое» для
// структурных проверок. git — только read-глаголы через src/git.ts. Regex здесь — по заголовкам hunk'ов diff'а
// (`@@ -a,b +c,d @@`), у них нет грамматики глубже этого. Нет git/репозитория → null с причиной (unknown, не pass).
import { git } from '../git.ts';
import type { ChangedFile } from './types.ts';

export type Added = { lines: Set<number>; all: boolean } | { lines: null; reason: string };

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

export function parseAdded(diff: string, into: Set<number>): void {
  let lineno: number | null = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { lineno = null; continue; }
    const m = HUNK.exec(raw);
    if (m) { lineno = Number(m[1]); continue; }
    if (lineno === null) continue;
    if (raw.startsWith('+')) { into.add(lineno); lineno++; }
  }
}

export function addedLines(file: ChangedFile, text: string): Added {
  const tracked = git(file.repo, ['ls-files', '--', file.path], 5000);
  if (tracked.rc !== 0) return { lines: null, reason: `git недоступен или каталог вне репозитория: ${tracked.stderr.trim().split('\n')[0] || 'rc ' + tracked.rc}` };
  const total = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (!tracked.stdout.trim()) return { lines: new Set(Array.from({ length: total }, (_, i) => i + 1)), all: true };
  const lines = new Set<number>();
  const vsHead = git(file.repo, ['diff', '-U0', 'HEAD', '--', file.path], 8000);
  if (vsHead.rc === 0) { parseAdded(vsHead.stdout, lines); return { lines, all: false }; }
  // HEAD ещё не родился (первый коммит не сделан): индекс против пустого дерева плюс рабочее дерево против индекса.
  const cached = git(file.repo, ['diff', '-U0', '--cached', '--', file.path], 8000);
  const work = git(file.repo, ['diff', '-U0', '--', file.path], 8000);
  if (cached.rc !== 0 && work.rc !== 0) return { lines: null, reason: `git diff не отвечает: ${(cached.stderr || work.stderr).trim().split('\n')[0]}` };
  if (cached.rc === 0) parseAdded(cached.stdout, lines);
  if (work.rc === 0) parseAdded(work.stdout, lines);
  return { lines, all: false };
}
