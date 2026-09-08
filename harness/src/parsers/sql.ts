// Настоящий парсер Postgres (libpg_query 17 в WASM, вендорен в vendor/pg-parser, VENDOR.lock — sha256).
// Правила гейтов формулируются над узлами AST, не над текстом (класс К1: INC-PG-READONLY-BYPASS).
// Ошибка разбора — значение, не исключение: гейт обязан превратить её в unknown/ask, не в pass.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export type Node = Record<string, unknown>;
export interface RawStmt { stmt: Node; stmt_location?: number; stmt_len?: number }
export interface SqlParse { stmts: RawStmt[]; error: string | null }

interface PgParserLike { parse(sql: string): Promise<{ tree?: { stmts?: RawStmt[] }; error?: { message?: string } | null }> }
let parserPromise: Promise<PgParserLike> | null = null;

function loadParser(): Promise<PgParserLike> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const mod = require(join(here, '..', '..', 'vendor', 'pg-parser', 'dist', 'index.cjs')) as { PgParser: new (o?: { version?: number }) => PgParserLike };
      return new mod.PgParser({ version: 17 });
    })();
  }
  return parserPromise;
}

export async function parseSql(sql: string): Promise<SqlParse> {
  try {
    const p = await loadParser();
    const r = await p.parse(sql);
    if (r.error) return { stmts: [], error: r.error.message ?? 'parse error' };
    return { stmts: r.tree?.stmts ?? [], error: null };
  } catch (e) {
    return { stmts: [], error: `parser unavailable: ${(e as Error).message.split('\n')[0]}` };
  }
}

/** Тип верхнего узла оператора: 'VariableSetStmt', 'AlterTableStmt', 'DoStmt', … */
export function stmtKind(s: RawStmt): string { return Object.keys(s.stmt ?? {})[0] ?? 'Unknown'; }
export function stmtNode<T = Node>(s: RawStmt): T { return (s.stmt as Record<string, T>)[stmtKind(s)]; }

/** Обход всех вложенных объектов AST (для FuncCall set_config и т. п.). */
export function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) { for (const x of node) yield* walk(x); return; }
  if (node && typeof node === 'object') { yield node as Node; for (const v of Object.values(node as Node)) yield* walk(v); }
}
