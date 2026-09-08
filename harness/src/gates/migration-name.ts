// migration-name — контракт имени миграции: имя файла задаёт порядок применения, имя класса и поле `name`
// задают запись в таблице migrations. Разошлись — порядок и учёт применённого расходятся тоже.
// Круглый timestamp (пять нулей на конце) назначен вручную «с запасом от соседей»: две ветки независимо
// приходят к одному значению, поэтому число обязано быть снятым.
//
// Regex — только по имени файла и строке цифр (грамматики там нет). Класс и поле `name` берутся из AST:
// текстовый поиск считает совпадением `name = '...'` внутри SQL-строки. Нет typescript рядом с файлом →
// `unknown` с причиной, не pass.
import { basename } from 'node:path';
import { register } from './registry.ts';
import { loadTypescript, parseSource, type TsModule } from '../parsers/ts.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';
import type * as TS from 'typescript';

export const NAME = 'migration-name';
export const KILL = 'CLAUDE_SKIP_MIGRATION_NAME_GUARD';

const IN_MIGRATIONS = /(^|\/)migrations?\//;
const FILE_FORM = /^(\d{13})-([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/;
const HAND_PICKED = /0{5}$/;

const SILENT: Verdict = { kind: 'silent' };
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Текст, который БУДЕТ записан. Для Edit/MultiEdit — только добавляемые куски: остальной файл не меняется. */
export function writtenText(p: PreToolUsePayload): { kind: 'text'; text: string } | { kind: 'unknown'; reason: string } {
  const ti = p.tool_input ?? {};
  if (p.tool_name === 'Write') {
    const content = str(ti.content);
    return content === null ? { kind: 'unknown', reason: 'Write без content — что ляжет в файл, неизвестно' } : { kind: 'text', text: content };
  }
  if (p.tool_name === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : null;
    if (!edits) return { kind: 'unknown', reason: 'MultiEdit без edits — что ляжет в файл, неизвестно' };
    return { kind: 'text', text: edits.map((e) => str((e as Record<string, unknown>)?.new_string) ?? '').join('\n') };
  }
  const newStr = str(ti.new_string);
  return newStr === null ? { kind: 'unknown', reason: 'Edit без new_string — что ляжет в файл, неизвестно' } : { kind: 'text', text: newStr };
}

export interface Identifiers { cls: string | null; name: string | null }

/** Имя класса миграции и значение поля `name` из AST. Форма `name = '...'` вне класса — тоже присваивание,
 *  а не строка: фрагмент Edit разбирается так же, как целый файл. Литерал внутри SQL-строки сюда не попадает. */
export function identifiers(ts: TsModule, sf: TS.SourceFile): Identifiers {
  let cls: string | null = null;
  let name: string | null = null;
  const literal = (n: TS.Node | undefined): string | null =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  const visit = (node: TS.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && cls === null) cls = node.name.text;
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'name' && name === null) {
      name = literal(node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && name === null) {
      const lhs = node.left;
      const isName = (ts.isIdentifier(lhs) && lhs.text === 'name')
        || (ts.isPropertyAccessExpression(lhs) && lhs.name.text === 'name');
      if (isName) name = literal(node.right);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { cls, name };
}

const expectedClass = (slug: string, stamp: string): string =>
  slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') + stamp;

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (ctx.event !== 'pre-write' || p.hook_event_name !== 'PreToolUse') return SILENT;
  if (p.tool_name !== 'Write' && p.tool_name !== 'Edit' && p.tool_name !== 'MultiEdit') return SILENT;
  const path = str(p.tool_input?.file_path) ?? '';
  if (!IN_MIGRATIONS.test(path) || !path.endsWith('.ts')) return SILENT;

  const base = basename(path);
  const form = FILE_FORM.exec(base);
  if (!form) {
    return { kind: 'deny', gate: NAME, reason: `имя файла «${base}» не в форме <timestamp13>-<kebab-name>.ts — TypeORM сортирует миграции по этому числу` };
  }
  const [, stamp, slug] = form;
  const problems: string[] = [];
  if (HAND_PICKED.test(stamp)) {
    problems.push(`timestamp ${stamp} придуман (оканчивается на пять нулей). Взять снятый: node -e 'console.log(Date.now())'`);
  }

  const written = writtenText(p);
  if (written.kind === 'unknown') return { kind: 'unknown', gate: NAME, reason: written.reason };

  const loaded = loadTypescript(path, ctx.env);
  if (!loaded.ts) {
    // Имя файла проверено, содержимое — нет. Молчать нельзя: половина контракта осталась недоказанной.
    const tail = `класс и поле name не проверены: ${loaded.missing_reason}`;
    return problems.length
      ? { kind: 'deny', gate: NAME, reason: `${base}: ${problems.join('; ')} (${tail})` }
      : { kind: 'unknown', gate: NAME, reason: `${base}: ${tail}` };
  }
  const { cls, name } = identifiers(loaded.ts, parseSource(loaded.ts, written.text, base).sf);
  if (cls !== null && !cls.endsWith(stamp)) problems.push(`класс «${cls}» не оканчивается на ${stamp} из имени файла`);
  if (name !== null && !name.endsWith(stamp)) problems.push(`поле name «${name}» не оканчивается на ${stamp} из имени файла`);
  const want = expectedClass(slug, stamp);
  if (cls !== null && cls !== want && cls.endsWith(stamp)) problems.push(`класс «${cls}» не совпадает с именем файла (ожидается «${want}»)`);

  if (!problems.length) return SILENT;
  return { kind: 'deny', gate: NAME, reason: `${base}: ${problems.join('; ')}` };
}

register({ name: NAME, events: ['pre-write'], killSwitch: KILL, run: decide });
