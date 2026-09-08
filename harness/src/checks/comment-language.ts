// Язык комментариев (H14): добавленная строка комментария с кириллицей в *.ts/*.tsx → fail с номером строки.
// Правило держалось на памяти модели (CHIP_comment-language-mix) — здесь оно машинное и по AST: строковые
// литералы, шаблоны и старые строки не считаются, хвостовой `// …` после кода — считается (текстовая дыра закрыта).
// Конвенция репозитория: `git config harness.comment-language ru` — русские комментарии норма, проверка проходит.
// Regex здесь — только по тексту комментария (кириллическая буква), у него нет грамматики. Kill-switch: CLAUDE_SKIP_COMMENT_LANGUAGE.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { git } from '../git.ts';
import { loadTypescript, parseSource, commentsByLine } from '../parsers/ts.ts';
import { addedLines } from './diff-added.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult, Checker } from './types.ts';

const CYRILLIC = /[А-Яа-яЁё]/;
const EXT = new Set(['.ts', '.tsx']);

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && EXT.has(extname(file.path)); }

export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  const convention = git(file.repo, ['config', '--get', 'harness.comment-language'], 3000);
  if (convention.rc === 0 && convention.stdout.trim() === 'ru') return { verdict: 'pass', message: 'repo convention: harness.comment-language=ru' };
  let text: string;
  try { text = readFileSync(file.absPath, 'utf8'); } catch (e) { return { verdict: 'unknown', missing_reason: `файл не читается: ${(e as Error).message.split('\n')[0]}` }; }
  const added = addedLines(file, text);
  if (!added.lines) return { verdict: 'unknown', missing_reason: added.reason };
  if (!added.lines.size) return { verdict: 'pass' };
  const loaded = loadTypescript(file.absPath, ctx.env);
  if (!loaded.ts) return { verdict: 'unknown', missing_reason: loaded.missing_reason };
  const { sf, errors } = parseSource(loaded.ts, text, file.absPath);
  if (errors.length) return { verdict: 'unknown', missing_reason: `файл не разобран: ${errors[0]}` };
  const hits: string[] = [];
  for (const [line, info] of commentsByLine(loaded.ts, sf)) {
    if (added.lines.has(line) && CYRILLIC.test(info.commentText)) hits.push(`L${line}`);
  }
  if (!hits.length) return { verdict: 'pass' };
  return { verdict: 'fail', message: `${file.path}: комментарии на кириллице в добавленных строках — ${hits.slice(0, 12).join(', ')}${hits.length > 12 ? ` и ещё ${hits.length - 12}` : ''}. В коде проекта комментарии по-английски; если для репозитория норма русский — git config harness.comment-language ru.` };
}

export const checker: Checker = { name: 'comment-language', tier: 'sync', killSwitch: 'CLAUDE_SKIP_COMMENT_LANGUAGE', applies, run };
registerChecker(checker);
