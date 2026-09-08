// Блок «Проверенный состав» в README.md между маркерами <!-- inventory:begin --> / <!-- inventory:end -->.
// Порт scripts/readme-inventory.sh: числа в прозе руками не живут.
//   node scripts/readme-inventory.ts [--root <brain>] [--sync]  перегенерировать блок на месте (по умолчанию);
//                                                               дата снимка меняется только вместе с данными
//   node scripts/readme-inventory.ts [--root <brain>] --check   rc 1 при дрейфе, README не трогает
// Считает только имена файлов и каталогов; содержимое читается у двух файлов — settings.json (какие хуки
// подключены) и самого README.md (текущий блок). Regex — над путями хуков в строках settings.json и над
// маркерами README: у обоих грамматики нет.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from './due.ts';

export interface Counts { hooks_total: number; wired: string[]; unwired: string[]; agents: number; skills: number; mem_roots: number; mem_files: number }
export interface Outcome { rc: number; stdout: string; stderr: string }
export interface InventoryOptions { root: string; now?: () => number }

const BEGIN = /<!-- inventory:begin[^\n]*-->\n/;
const END = '<!-- inventory:end -->';

function entries(dir: string, pred: (p: string, name: string) => boolean): string[] {
  try { return readdirSync(dir).filter((n) => { try { return pred(join(dir, n), n); } catch { return false; } }).sort(); } catch { return []; }
}
const isFile = (p: string) => statSync(p).isFile();
const isDir = (p: string) => statSync(p).isDirectory();

function walkMd(dir: string): number {
  let n = 0;
  for (const name of entries(dir, () => true)) {
    const p = join(dir, name);
    if (isDir(p)) n += walkMd(p); else if (name.endsWith('.md') && isFile(p)) n++;
  }
  return n;
}

/** Все строковые листья JSON (рекурсивный обход, без внешних утилит). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

export function counts(root: string): Counts {
  const hooks = entries(join(root, 'hooks'), (p, n) => n.endsWith('.sh') && isFile(p));
  const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as unknown;
  const wired = new Set<string>();
  for (const s of strings(settings)) {
    if (!/hooks\/[^ ]+\.sh/.test(s)) continue;
    for (const m of s.match(/[^/ ]+\.sh/g) ?? []) wired.add(m);
  }
  const wiredList = [...wired].sort();
  return {
    hooks_total: hooks.length,
    wired: wiredList,
    unwired: hooks.filter((h) => !wired.has(h)),
    agents: entries(join(root, 'agents'), (p, n) => n.endsWith('.md') && isFile(p)).length,
    skills: entries(join(root, 'skills'), (p, n) => isDir(p) && !n.endsWith('-workspace')).length,
    mem_roots: entries(join(root, 'memory'), (p) => isDir(p)).length,
    mem_files: walkMd(join(root, 'memory')),
  };
}

export function dataLines(c: Counts): string[] {
  return [
    `- \`hooks/*.sh\`: ${c.hooks_total}; из них ${c.wired.length} подключены в \`settings.json\`;`,
    `- не зарегистрированы как lifecycle hooks: ${c.unwired.length ? c.unwired.map((h) => `\`${h}\``).join(', ') : '—'};`,
    `- \`agents/*.md\`: ${c.agents};`,
    `- верхнеуровневых authored skills: ${c.skills};`,
    `- project-memory roots: ${c.mem_roots}, файлов памяти: ${c.mem_files}.`,
  ];
}

/** Текущий блок README без строки «Снимок …» и пустых строк — сравнивается только факт. */
export function currentData(readme: string): string[] | null {
  const b = BEGIN.exec(readme); const e = readme.indexOf(END);
  if (!b || e < 0 || e < b.index) return null;
  return readme.slice(b.index + b[0].length, e).split('\n').filter((l) => l !== '' && !l.startsWith('Снимок'));
}

export function snapshotBlock(data: string[], today: string): string {
  const [y, m, d] = today.split('-');
  return `Снимок **${d}.${m}.${y}**, сгенерирован из файлов (\`harness/scripts/readme-inventory.ts --sync\`):\n\n${data.join('\n')}\n`;
}

function diffLines(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`< ${a[i]}`);
    if (b[i] !== undefined) out.push(`> ${b[i]}`);
  }
  return out.slice(0, 12);
}

export function run(argv: string[], opts: InventoryOptions): Outcome {
  const args = [...argv]; let root = opts.root;
  if (args[0] === '--root') { if (!args[1]) return { rc: 2, stdout: '', stderr: 'readme-inventory: --root требует каталог\n' }; root = args[1]; args.splice(0, 2); }
  const mode = args[0] ?? '--sync';
  if (mode !== '--sync' && mode !== '--check') return { rc: 2, stdout: '', stderr: `readme-inventory: неизвестный аргумент ${mode}\n` };
  if (args.length > 1) return { rc: 2, stdout: '', stderr: `readme-inventory: лишний аргумент ${args[1]}\n` };
  const readmePath = join(root, 'README.md');
  let readme: string;
  try { readme = readFileSync(readmePath, 'utf8'); } catch { return { rc: 1, stdout: '', stderr: `readme-inventory: ${readmePath} не читается\n` }; }
  const current = currentData(readme);
  if (current === null) return { rc: 1, stdout: '', stderr: 'readme-inventory: маркеры inventory:begin/end не найдены в README.md\n' };
  let data: string[];
  try { data = dataLines(counts(root)); } catch (e) { return { rc: 1, stdout: '', stderr: `readme-inventory: состав не посчитан (${(e as Error).message.split('\n')[0]}) — инвентарь неизвестен\n` }; }
  if (current.join('\n') === data.join('\n')) return { rc: 0, stdout: '', stderr: '' };
  if (mode === '--check') {
    return { rc: 1, stdout: '', stderr: ['readme-inventory: блок «Проверенный состав» разошёлся с фактом. Обновить: harness/scripts/readme-inventory.ts --sync', ...diffLines(current, data)].join('\n') + '\n' };
  }
  const b = BEGIN.exec(readme) as RegExpExecArray; const e = readme.indexOf(END);
  const next = readme.slice(0, b.index + b[0].length) + snapshotBlock(data, localDate((opts.now ?? Date.now)())) + readme.slice(e);
  writeFileSync(readmePath, next);
  return { rc: 0, stdout: '', stderr: '' };
}

const isMain = (() => { try { return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isMain) {
  const out = run(process.argv.slice(2), { root: join(dirname(fileURLToPath(import.meta.url)), '..', '..') });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}
