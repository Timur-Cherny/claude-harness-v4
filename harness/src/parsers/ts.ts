// TypeScript compiler API как парсер (К1: структура вместо текста). Модуль берётся createRequire из
// node_modules/typescript ближайшего вверх от проверяемого файла — версия проекта, не харнесса; для скриптов
// вне проекта — CLAUDE_HARNESS_TS (путь к typescript.js или к каталогу пакета). Нет ни того ни другого → { ts: null }
// с причиной: вызывающий обязан отдать `unknown`, не pass. Ошибки разбора — parseDiagnostics, не исключение.
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import type * as TS from 'typescript';

export type TsModule = typeof TS;
export type Loaded = { ts: TsModule; from: string } | { ts: null; missing_reason: string };

const cache = new Map<string, TsModule>();

function loadFrom(key: string, load: () => unknown): TsModule | null {
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const mod = load() as TsModule;
    if (typeof mod?.createSourceFile !== 'function') return null;
    cache.set(key, mod);
    return mod;
  } catch { return null; }
}

/** Каталог, в котором лежит node_modules/typescript, ближайший вверх от `near` (файл или каталог). */
export function nearestTypescriptDir(near: string): string | null {
  let dir: string;
  try { dir = statSync(near).isDirectory() ? near : dirname(near); } catch { dir = dirname(near); }
  dir = resolve(dir);
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'typescript', 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadTypescript(near: string | null, env: NodeJS.ProcessEnv): Loaded {
  const dir = near ? nearestTypescriptDir(near) : null;
  if (dir) {
    const ts = loadFrom(`dir:${dir}`, () => createRequire(join(dir, 'package.json'))('typescript'));
    if (ts) return { ts, from: dir };
  }
  const pinned = env.CLAUDE_HARNESS_TS;
  if (pinned) {
    const p = resolve(pinned);
    const ts = loadFrom(`pin:${p}`, () => createRequire(import.meta.url)(p));
    if (ts) return { ts, from: p };
    return { ts: null, missing_reason: 'typescript: CLAUDE_HARNESS_TS не загружается как модуль typescript' };
  }
  return { ts: null, missing_reason: 'typescript не найден: нет node_modules/typescript вверх от файла и не задан CLAUDE_HARNESS_TS' };
}

export interface Parsed { sf: TS.SourceFile; errors: string[] }

function scriptKind(ts: TsModule, fileName: string): TS.ScriptKind {
  switch (extname(fileName)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/** Разбор с родительскими ссылками; синтаксические ошибки — списком сообщений (первые 3), не исключением. */
export function parseSource(ts: TsModule, text: string, fileName: string): Parsed {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(ts, fileName));
  const diags = ((sf as unknown as { parseDiagnostics?: TS.DiagnosticWithLocation[] }).parseDiagnostics ?? []);
  const errors = diags.slice(0, 3).map((d) => {
    const { line } = sf.getLineAndCharacterOfPosition(d.start);
    return `L${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
  return { sf, errors };
}

export interface CommentRange { pos: number; end: number }

/** Все комментарии файла: leading у fullStart каждого узла/токена + trailing у его end. Токены (скобки, EOF) — через getChildren. */
export function commentRanges(ts: TsModule, sf: TS.SourceFile): CommentRange[] {
  const text = sf.text; const seen = new Set<number>(); const out: CommentRange[] = [];
  const add = (ranges: readonly TS.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) if (!seen.has(r.pos)) { seen.add(r.pos); out.push({ pos: r.pos, end: r.end }); }
  };
  const visit = (node: TS.Node): void => {
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const c of node.getChildren(sf)) visit(c);
  };
  visit(sf);
  return out.sort((a, b) => a.pos - b.pos);
}

export interface LineComments { startsWithComment: boolean; commentText: string }

/** По строкам (1-based): начинается ли строка с комментария и какой текст комментариев на ней лежит. */
export function commentsByLine(ts: TsModule, sf: TS.SourceFile): Map<number, LineComments> {
  const text = sf.text; const mark = new Uint8Array(text.length + 1);
  for (const r of commentRanges(ts, sf)) mark.fill(1, r.pos, r.end);
  const starts = sf.getLineStarts(); const out = new Map<number, LineComments>();
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]; const e = i + 1 < starts.length ? starts[i + 1] : text.length;
    let j = s; while (j < e && /\s/.test(text[j])) j++;
    let commentText = '';
    for (let k = s; k < e; k++) if (mark[k]) commentText += text[k];
    if (!commentText && !(j < e && mark[j])) continue;
    out.set(i + 1, { startsWithComment: j < e && mark[j] === 1, commentText: commentText.replace(/[\r\n]+$/, '') });
  }
  return out;
}

export function lineOf(sf: TS.SourceFile, pos: number): number { return sf.getLineAndCharacterOfPosition(pos).line + 1; }
