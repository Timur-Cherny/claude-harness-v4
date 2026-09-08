// Поколение контура — хеш содержимого рабочего дерева харнесса (не индекса: незастейдженная правка
// обязана сдвинуть поколение, иначе подтверждение переживёт изменение, которое его отменяет).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let memo: { root: string; gen: string } | null = null;

export function generation(root: string): string {
  if (memo && memo.root === root) return memo.gen;
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { if (n !== 'node_modules' && n !== '.git') walk(p); continue; }
      if (/\.(ts|regex|sh)$/.test(n) || n === 'hook') { h.update(p.slice(root.length)); h.update(readFileSync(p)); }
    }
  };
  for (const sub of ['src', 'bin', 'vendor']) { try { walk(join(root, sub)); } catch { /* каталога нет */ } }
  const gen = h.digest('hex').slice(0, 16);
  memo = { root, gen };
  return gen;
}
