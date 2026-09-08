// memory-frontmatter — порт hooks/memory-integrity.sh (часть про ОДИН файл памяти), перенесённый
// с PostToolUse на PreToolUse: проверяется содержимое, которое БУДЕТ записано (Write.content; для Edit —
// текущий файл с применённой заменой), и нарушение ловится до того, как файл лёг на диск.
// Связность индекса MEMORY.md (режим Stop оригинала) — не здесь.
// Regex — только по строкам frontmatter вида `key: value` и по пути файла (строки без грамматики):
// строгий мини-парсер трёх полей (name, description, metadata.type) без YAML-библиотеки.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { register } from './registry.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'memory-frontmatter';
export const KILL = 'CLAUDE_SKIP_MEMORY_INTEGRITY';
export const ALLOWED_TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);

const NOTE_PATH = /\/\.claude\/projects\/[^/]+\/memory\/([^/]+)\.md$/;
const TOP_KEY = /^([A-Za-z_][\w-]*):(.*)$/;
const SUB_KEY = /^\s+([A-Za-z_][\w-]*):(.*)$/;
const BLOCK_SCALAR = /^[>|][-+]?$/;

/** Слаг ноты памяти или null: путь не под .claude/projects/<proj>/memory/<slug>.md либо это сам индекс MEMORY.md. */
export function noteSlug(path: string): string | null {
  const m = NOTE_PATH.exec(path);
  if (!m || m[1] === 'MEMORY') return null;
  return m[1];
}

export interface Frontmatter {
  fields: Map<string, string>;
  nested: Map<string, Map<string, string>>;
  closed: boolean;
  body: string[];
}

/** Мини-парсер: `---`, строки `key: value` и один уровень вложенности `  key: value`; `>`/`|` — блок до конца отступа. */
export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const fields = new Map<string, string>();
  const nested = new Map<string, Map<string, string>>();
  let closed = false;
  let end = lines.length;
  let current: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') { closed = true; end = i; break; }
    const top = TOP_KEY.exec(line);
    if (top) {
      const key = top[1];
      let value = top[2].trim();
      if (BLOCK_SCALAR.test(value)) {
        const chunk: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && lines[i + 1].trim() !== '---') chunk.push(lines[++i].trim());
        value = chunk.join(' ');
      }
      fields.set(key, value);
      current = key;
      if (!nested.has(key)) nested.set(key, new Map());
      continue;
    }
    const sub = SUB_KEY.exec(line);
    if (sub && current) nested.get(current)!.set(sub[1], sub[2].trim());
  }
  return { fields, nested, closed, body: closed ? lines.slice(end + 1) : [] };
}

function unquote(v: string): string {
  const m = /^(["'])(.*)\1$/.exec(v.trim());
  return (m ? m[2] : v).trim();
}

/** Список нарушений; пустой список — нота корректна. */
export function checkNote(text: string, slug: string): string[] {
  const fm = parseFrontmatter(text);
  if (!fm) return ['нет frontmatter (первая строка должна быть ---)'];
  const problems: string[] = [];
  if (!fm.closed) problems.push('frontmatter не закрыт (нет второй строки ---)');
  const name = fm.fields.get('name');
  if (!name) problems.push('нет поля name');
  else if (unquote(name) !== slug) problems.push(`name '${unquote(name)}' не совпадает с именем файла '${slug}' (ссылки [[${slug}]] не разрешатся)`);
  if (!unquote(fm.fields.get('description') ?? '')) problems.push('пустой description — по нему решается, открывать ли запись');
  const type = fm.nested.get('metadata')?.get('type');
  if (!type) problems.push('нет metadata.type');
  else if (!ALLOWED_TYPES.has(unquote(type))) problems.push(`type '${unquote(type)}' не из набора (${[...ALLOWED_TYPES].join(' ')})`);
  if (!fm.body.some((l) => l.trim())) problems.push('пустое тело');
  return problems;
}

const SILENT: Verdict = { kind: 'silent' };
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

type Projected = { kind: 'text'; text: string } | { kind: 'unknown'; reason: string };

/** Содержимое файла ПОСЛЕ инструмента: Write — как есть; Edit — текущий файл с заменой. */
export function projectedText(p: PreToolUsePayload): Projected {
  const ti = p.tool_input ?? {};
  if (p.tool_name === 'Write') {
    const content = str(ti.content);
    return content === null ? { kind: 'unknown', reason: 'Write без content — результат записи неизвестен' } : { kind: 'text', text: content };
  }
  const path = str(ti.file_path) ?? '';
  const oldStr = str(ti.old_string); const newStr = str(ti.new_string);
  if (oldStr === null || newStr === null) return { kind: 'unknown', reason: 'Edit без old_string/new_string — результат правки неизвестен' };
  let current: string;
  try { current = readFileSync(path, 'utf8'); } catch { return { kind: 'unknown', reason: `файл памяти ${basename(path)} не прочитан — правку не к чему применить` }; }
  if (oldStr === '') return { kind: 'text', text: current + newStr };
  const at = current.indexOf(oldStr);
  if (at < 0) return { kind: 'unknown', reason: 'old_string не найден в файле — результат правки не предсказать' };
  const text = ti.replace_all === true ? current.split(oldStr).join(newStr) : current.slice(0, at) + newStr + current.slice(at + oldStr.length);
  return { kind: 'text', text };
}

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (ctx.event !== 'pre-write' || p.hook_event_name !== 'PreToolUse') return SILENT;
  if (p.tool_name !== 'Write' && p.tool_name !== 'Edit') return SILENT;
  const path = str(p.tool_input?.file_path) ?? '';
  const slug = noteSlug(path);
  if (!slug) return SILENT;
  const projected = projectedText(p);
  if (projected.kind === 'unknown') return { kind: 'unknown', reason: projected.reason, gate: NAME };
  const problems = checkNote(projected.text, slug);
  if (!problems.length) return SILENT;
  return { kind: 'deny', reason: `${basename(path)}: ${problems.join('; ')}`, gate: NAME };
}

register({ name: NAME, events: ['pre-write'], killSwitch: KILL, run: decide });
