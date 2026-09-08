// Stop-часть memory-integrity: связность индекса памяти ТЕКУЩЕГО проекта (каталог берётся от transcript_path).
// Нота без строки в MEMORY.md потеряется — её не увидят в начале сессии; строка индекса на несуществующий
// файл ведёт в никуда; висячие [[ссылки]] легальны и перечисляются только когда их больше пяти.
// Не блокирует — печатает (context), как оригинал. Kill-switch общий с проверкой шапки при записи
// (та живёт в pre-write гейте другой группы). Regex — по строкам без грамматики: строка индекса `(имя.md)`
// и wiki-ссылка `[[имя]]`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { register } from '../gates/registry.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'memory-index';
export const KILL = 'CLAUDE_SKIP_MEMORY_INTEGRITY';
export const DEAD_LINKS_TOLERATED = 5;

export interface IndexReport { orphans: string[]; dangling: string[]; deadLinks: number; indexMissing: boolean }

export function inspect(memDir: string): IndexReport | null {
  let names: string[];
  try { names = readdirSync(memDir).filter((n) => n.endsWith('.md') && statSync(join(memDir, n)).isFile()); } catch { return null; }
  const notes = names.filter((n) => n !== 'MEMORY.md').sort();
  const idxPath = join(memDir, 'MEMORY.md');
  if (!existsSync(idxPath)) return { orphans: notes, dangling: [], deadLinks: 0, indexMissing: true };
  const idx = readFileSync(idxPath, 'utf8');
  const orphans = notes.filter((n) => !idx.includes(`(${n})`));
  const referenced = [...new Set([...idx.matchAll(/\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1]))];
  const dangling = referenced.filter((n) => !existsSync(join(memDir, n)));
  const links = new Set<string>();
  for (const n of names) for (const m of readFileSync(join(memDir, n), 'utf8').matchAll(/\[\[([a-z0-9-]+)\]\]/g)) links.add(m[1]);
  const deadLinks = [...links].filter((l) => !existsSync(join(memDir, `${l}.md`))).length;
  return { orphans, dangling, deadLinks, indexMissing: false };
}

export function decide(ctx: GateContext): Verdict {
  const tr = (ctx.payload as { transcript_path?: unknown }).transcript_path;
  if (typeof tr !== 'string' || !tr) return { kind: 'unknown', reason: 'в payload нет transcript_path — каталог памяти проекта неизвестен', gate: NAME };
  const memDir = join(dirname(tr), 'memory');
  const rep = inspect(memDir);
  if (rep === null) return { kind: 'silent' }; // у проекта нет памяти — норма
  const out: string[] = [];
  if (rep.indexMissing) { if (rep.orphans.length) out.push(`  индекса MEMORY.md нет — все ${rep.orphans.length} нот(ы) без строки в индексе`); }
  else {
    for (const n of rep.orphans) out.push(`  сирота, нет строки в индексе: ${n}`);
    for (const n of rep.dangling) out.push(`  строка индекса ведёт в никуда: ${n}`);
    if (rep.deadLinks > DEAD_LINKS_TOLERATED) out.push(`  висячих ссылок ${rep.deadLinks} — пора либо написать записи, либо снять ссылки`);
  }
  if (!out.length) return { kind: 'silent' };
  return { kind: 'context', text: ['⚠️ [memory-integrity] связность индекса:', ...out].join('\n'), gate: NAME };
}

const gate: Gate = { name: NAME, events: ['stop'], killSwitch: KILL, run: decide };
register(gate);
