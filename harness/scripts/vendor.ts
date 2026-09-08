// Единственный способ обновить vendor/: копирует объявленные файлы пакета из node_modules и переписывает VENDOR.lock.
// Запуск: node scripts/vendor.ts <путь к node_modules/@supabase/pg-parser>
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['dist/index.cjs', 'dist/index.d.cts', 'wasm/17/pg-parser.js', 'wasm/17/pg-parser.wasm', 'LICENSE'];

export function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

export function writeLock(pkgDir: string | null): void {
  const dst = join(root, 'vendor', 'pg-parser');
  const pkg = pkgDir ? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string; version: string; license: string; repository?: { url?: string } } : null;
  if (pkgDir) for (const f of FILES) {
    mkdirSync(dirname(join(dst, f)), { recursive: true });
    if (f === 'LICENSE' && !existsSync(join(pkgDir, f))) { writeFileSync(join(dst, f), `${pkg?.license ?? 'MIT'} — файла LICENSE в пакете нет; текст лицензии: ${pkg?.repository?.url ?? ''}\n`); continue; }
    copyFileSync(join(pkgDir, f), join(dst, f));
  }
  const prev = (() => { try { return JSON.parse(readFileSync(join(root, 'VENDOR.lock'), 'utf8')); } catch { return null; } })();
  const lock = {
    package: pkg?.name ?? prev?.package ?? '@supabase/pg-parser',
    version: pkg?.version ?? prev?.version,
    license: pkg?.license ?? prev?.license ?? 'MIT',
    source: pkg?.repository?.url ?? prev?.source ?? 'https://github.com/supabase-community/pg-parser',
    command: 'node scripts/vendor.ts <node_modules/@supabase/pg-parser>',
    files: Object.fromEntries(FILES.map((f) => [`vendor/pg-parser/${f}`, sha256(join(dst, f))])),
  };
  writeFileSync(join(root, 'VENDOR.lock'), JSON.stringify(lock, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeLock(process.argv[2] ?? null);
  console.log(readFileSync(join(root, 'VENDOR.lock'), 'utf8'));
}
