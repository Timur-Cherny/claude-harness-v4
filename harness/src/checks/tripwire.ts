// Растяжка доставки сообщений (порт hooks/message-delivery-tripwire.sh): правка ДОБАВИЛА код publish/emit/
// after-commit/detached side effect/one-shot listener/consumer/ack-dlq/outbox/webhook → напоминание прогнать
// code-delivery-audit: тихая потеря событий, «отправилось один раз» и dual-write happy-path не ловит. Сигнал — из
// структуры TS-AST на добавленных строках: вызовы по имени метода, декораторы, идентификаторы и строковые литералы
// (имена модулей, топиков, URL). Комментарии не считаются. Языки без парсера (go/py/java/…) не проверяются (К1).
// Kill-switch: CLAUDE_SKIP_DELIVERY_TRIPWIRE.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { loadTypescript, parseSource, lineOf, type TsModule } from '../parsers/ts.ts';
import { addedLines } from './diff-added.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult, Checker } from './types.ts';
import type * as TS from 'typescript';

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const METHOD_CATEGORY: Record<string, string> = { publish: 'publish', sendMessage: 'publish', emit: 'delivery-code', once: 'once-listener', nack: 'ack/dlq', afterCommit: 'after-commit-hook', nextTick: 'detached-side-effect' };
const FUNCTION_CATEGORY: Record<string, string> = { runOnTransactionCommit: 'after-commit-hook', afterCommit: 'after-commit-hook', setImmediate: 'detached-side-effect' };
const DECORATOR_CATEGORY: Record<string, string> = { RabbitSubscribe: 'consumer', EventPattern: 'consumer', MessagePattern: 'consumer', AfterTransactionCommit: 'after-commit-hook' };
// Слова в идентификаторах и строковых литералах: у имени грамматики нет, поиск подстроки допустим.
const WORD_CATEGORY: Array<[RegExp, string]> = [
  [/outbox/i, 'outbox'], [/webhook/i, 'webhook'], [/amqp/i, 'publish'], [/dead[-_. ]?letter/i, 'ack/dlq'], [/requeue/i, 'ack/dlq'],
];

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && EXT.has(extname(file.path)); }

interface Hit { line: number; category: string }

function decoratorName(ts: TsModule, d: TS.Decorator): string | null {
  const e = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
}

export function findHits(ts: TsModule, sf: TS.SourceFile, added: Set<number>): Hit[] {
  const hits: Hit[] = [];
  const push = (node: TS.Node, category: string): void => { const line = lineOf(sf, node.getStart(sf)); if (added.has(line)) hits.push({ line, category }); };
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text; const receiver = callee.expression.getText(sf);
        if (name in METHOD_CATEGORY && !(name === 'nextTick' && receiver !== 'process')) push(callee.name, METHOD_CATEGORY[name]);
        else if (name === 'send' && /producer$|kafka/i.test(receiver)) push(callee.name, 'publish');
      } else if (ts.isIdentifier(callee) && callee.text in FUNCTION_CATEGORY) push(callee, FUNCTION_CATEGORY[callee.text]);
    }
    if (ts.isDecorator(n)) { const name = decoratorName(ts, n); if (name && name in DECORATOR_CATEGORY) push(n, DECORATOR_CATEGORY[name]); }
    if (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) {
      for (const [re, cat] of WORD_CATEGORY) if (re.test(n.text)) push(n, cat);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  let text: string;
  try { text = readFileSync(file.absPath, 'utf8'); } catch (e) { return { verdict: 'unknown', missing_reason: `файл не читается: ${(e as Error).message.split('\n')[0]}` }; }
  const added = addedLines(file, text);
  if (!added.lines) return { verdict: 'unknown', missing_reason: added.reason };
  if (!added.lines.size) return { verdict: 'pass' };
  const loaded = loadTypescript(file.absPath, ctx.env);
  if (!loaded.ts) return { verdict: 'unknown', missing_reason: loaded.missing_reason };
  const { sf, errors } = parseSource(loaded.ts, text, file.absPath);
  if (errors.length) return { verdict: 'unknown', missing_reason: `файл не разобран: ${errors[0]}` };
  const hits = findHits(loaded.ts, sf, added.lines);
  if (!hits.length) return { verdict: 'pass' };
  const cats = [...new Set(hits.map((h) => h.category))].join(' ');
  const where = [...new Set(hits.map((h) => `L${h.line}`))].slice(0, 6).join(' ');
  const msg = [
    `Правка затрагивает доставку событий/сообщений (${cats}) в ${file.path}: ${where}.`,
    'Это класс, где прячутся тихая потеря событий / «отправилось один раз» / dual-write — happy-path тест их не ловит.',
    'Прогони скилл code-delivery-audit по этому изменению перед тем как считать готовым:',
    '  адверсариальные сценарии — rollback-after-publish, crash-after-commit, redelivery, second-and-subsequent item, poison message.',
    'Заглушить для этой сессии: export CLAUDE_SKIP_DELIVERY_TRIPWIRE=1',
  ].join('\n');
  return { verdict: 'fail', message: msg };
}

export const checker: Checker = { name: 'tripwire', tier: 'sync', killSwitch: 'CLAUDE_SKIP_DELIVERY_TRIPWIRE', applies, run };
registerChecker(checker);
