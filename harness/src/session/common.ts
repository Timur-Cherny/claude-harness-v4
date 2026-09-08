// Общие мелочи сборщиков сессии: короткий хеш пути (метка вместо пути в журнале/ключах),
// счётчик строк файла (None → null: отсутствие источника — не ноль), локальная дата без `date`.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/** 12 hex sha256 — метка репозитория для журнала (I3: путь наружу не уходит). */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Число строк файла; null — источника нет (unknown, не 0). */
export function lineCount(path: string): number | null {
  try {
    const txt = readFileSync(path, 'utf8');
    if (txt.length === 0) return 0;
    return txt.split('\n').filter((l) => l.length > 0).length;
  } catch { return null; }
}

export function fileSize(path: string): number | null {
  try { const s = statSync(path); return s.isFile() ? s.size : null; } catch { return null; }
}

export function fileMtime(path: string): number | null {
  try { return Math.floor(statSync(path).mtimeMs); } catch { return null; }
}

/** Локальная дата `YYYY-MM-DD` из миллисекунд эпохи (как `date +%F` в оригинале). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Разница в днях между двумя date-only метками; null при нечитаемой дате. */
export function daysBetween(fromIso: string | null | undefined, toIso: string): number | null {
  if (!fromIso) return null;
  const a = parseDateOnly(fromIso); const b = parseDateOnly(toIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

function parseDateOnly(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
