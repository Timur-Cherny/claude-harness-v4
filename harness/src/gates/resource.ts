// resource-guard — PreToolUse(Bash): тяжёлая команда при перегрузе НЕ отклоняется, а ждёт окна ресурсов
// (очередь, INC-RESOURCE-GUARD-TOKEN-LOOP: мгновенный reject → агент переоткрывает обход, 51 столкновение
// за две недели). Лёгкие команды проходят без единого обращения к платформе. Память — только
// platform.memory() (process.availableMemory): os.freemem на этой машине показывает 69 MB при 4,6 GB
// доступных и превращает любой порог в стену. Ожидание обязано быть короче timeout хука в settings.json
// (300 с): убитый по таймауту PreToolUse не блокирует — поэтому потолок MAX_WAIT_S зашит и env его не поднимает.
// Тяжесть — по токенизатору (имя команды и её аргументы), не по regex по строке: `grep jest README.md`
// и `echo "npx jest"` — не тесты. Единственный regex здесь — HEAVY_WORD_RE по непрозрачным частям
// команды ($(…), `…`, here-doc), у которых грамматики нет; он даёт только `unknown`, никогда `silent`.
import { register } from './registry.ts';
import { memory as platformMemory, type MemorySignal } from '../platform.ts';
import { tokenize, commands } from '../parsers/shell.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'resource-guard';
export const KILL_SWITCH = 'CLAUDE_SKIP_RESOURCE_GUARD';

export const DEFAULT_MIN_MB = 2000;
export const DEFAULT_MAX_LOAD = 2.0;
export const DEFAULT_WAIT_S = 240;
export const DEFAULT_POLL_S = 15;
/** Потолок ожидания: timeout хука в settings.json — 300 с; env не может поднять ожидание выше. */
export const MAX_WAIT_S = 240;

export interface ResourceDeps {
  memory: () => MemorySignal;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

export const defaults: ResourceDeps = {
  memory: platformMemory,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const HEAVY_BINARIES = new Set(['jest', 'vitest', 'gradlew', 'xcodebuild', 'webpack', 'corp-claude']);
const PACKAGE_RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const EXEC_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const HEAVY_WORD_RE = /(^|[^A-Za-z0-9_])(jest|vitest|playwright|gradlew?|xcodebuild|webpack|corp-claude)([^A-Za-z0-9_]|$)/;

function base(tok: string): string {
  const b = tok.split('/').pop() ?? tok;
  return b.replace(/\.(c|m)?js$/, '');
}

/** Первый токен без ведущего дефиса и хвост за ним: флаги пропускаются, аргументы сохраняются. */
function split(tokens: string[]): { first: string; tail: string[] } {
  const i = tokens.findIndex((t) => !t.startsWith('-'));
  return i < 0 ? { first: '', tail: [] } : { first: tokens[i], tail: tokens.slice(i + 1) };
}

function isHeavyScript(script: string): boolean {
  return script === 't' || script === 'tst' || script.startsWith('test') || script.startsWith('build');
}

/** Тяжёлая ли одна команда (имя + аргументы); возвращает метку паттерна или null. */
export function heavyCommand(name: string, rest: string[]): string | null {
  const n = base(name);
  if (HEAVY_BINARIES.has(n)) return n;
  const args = rest.filter((t) => !t.startsWith('-'));
  const { first, tail } = split(rest);
  switch (n) {
    case 'gradle': { const task = args.find((a) => a === 'build' || a === 'test' || a.startsWith('assemble')); return task ? `gradle ${task}` : null; }
    case 'pod': return first === 'install' ? 'pod install' : null;
    case 'next': case 'vite': return first === 'build' ? `${n} build` : null;
    case 'tsc': return rest.includes('-b') || rest.includes('--build') ? 'tsc -b' : null;
    case 'docker': {
      if (first === 'build' || (first === 'buildx' && args[1] === 'build')) return 'docker build';
      if (first === 'compose' && args.includes('up')) return 'docker compose up';
      return null;
    }
    case 'docker-compose': return args.includes('up') ? 'docker compose up' : null;
    case 'kind': return first === 'create' || first === 'load' ? `kind ${first}` : null;
    case 'emulator': return rest.includes('-avd') ? 'emulator -avd' : null;
    case 'playwright': return first === 'test' ? 'playwright test' : null;
    case 'node': return first ? heavyCommand(first, tail) : null;
  }
  if (EXEC_RUNNERS.has(n)) return first ? heavyCommand(first, tail) : null;
  if (PACKAGE_RUNNERS.has(n)) {
    if (!first) return null;
    if (first === 'exec' || first === 'x') { const bin = split(tail); return bin.first ? heavyCommand(bin.first, bin.tail) : null; }
    if (first === 'run' || first === 'run-script') { const script = split(tail).first; return isHeavyScript(script) ? `${n} run ${script}` : null; }
    if (isHeavyScript(first)) return `${n} ${first}`;
    return heavyCommand(first, tail); // yarn jest, pnpm vitest
  }
  return null;
}

export interface Classification { heavy: string | null; opaque: string[]; bypassed?: string }

/** Сознательный разовый обход — присвоение KILL_SWITCH=1 в префиксе ТОГО ЖЕ сегмента (`X=1 npx jest`),
 *  а не подстрока где угодно: bash-grep пропускал `echo X=1 && npx jest` и `jest -t "X=1"` (класс К1). */
function bypassedByPrefix(argv: string[], name: string): boolean {
  const at = argv.indexOf(name);
  return argv.slice(0, at < 0 ? 0 : at).includes(`${KILL_SWITCH}=1`);
}

/** Тяжесть всей команды: сегменты (включая один уровень sh -c/eval) плюс непрозрачные части. */
export function classify(cmd: string): Classification {
  const parse = tokenize(cmd);
  let bypassed: string | undefined;
  for (const c of commands(parse)) {
    const h = heavyCommand(c.name, c.rest);
    if (!h) continue;
    if (bypassedByPrefix(c.argv, c.name)) { bypassed = h; continue; }
    return { heavy: h, opaque: parse.unknown };
  }
  if (parse.unknown.length && HEAVY_WORD_RE.test(cmd)) return { heavy: null, opaque: parse.unknown, ...(bypassed ? { bypassed } : {}) };
  return { heavy: null, opaque: [], ...(bypassed ? { bypassed } : {}) };
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
}

export interface Thresholds { minMb: number; maxLoad: number; waitS: number; pollS: number }

export function thresholds(env: NodeJS.ProcessEnv): Thresholds {
  return {
    minMb: num(env.RESOURCE_GUARD_MIN_MB, DEFAULT_MIN_MB),
    maxLoad: num(env.RESOURCE_GUARD_MAX_LOAD, DEFAULT_MAX_LOAD),
    waitS: Math.min(num(env.RESOURCE_GUARD_WAIT_S, DEFAULT_WAIT_S), MAX_WAIT_S),
    pollS: Math.max(num(env.RESOURCE_GUARD_POLL_S, DEFAULT_POLL_S), 1),
  };
}

function closedReason(sig: MemorySignal, t: Thresholds): string | null {
  const parts: string[] = [];
  if ((sig.available_mb ?? 0) < t.minMb) parts.push(`память ${sig.available_mb}MB при пороге ${t.minMb}MB`);
  if (sig.load_per_core > t.maxLoad) parts.push(`load/core ${sig.load_per_core.toFixed(2)} при пороге ${t.maxLoad}`);
  return parts.length ? parts.join(', ') : null;
}

export async function decide(ctx: GateContext, deps: ResourceDeps = defaults): Promise<Verdict> {
  const p = ctx.payload;
  if (!('tool_name' in p) || p.tool_name !== 'Bash') return { kind: 'silent' };
  const cmd = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';
  if (!cmd) return { kind: 'silent' };
  const cls = classify(cmd);
  if (!cls.heavy) {
    if (cls.opaque.length) return { kind: 'unknown', reason: `тяжёлое слово внутри непрозрачной части команды (${cls.opaque.join(', ')}) — тяжесть не доказать`, gate: NAME };
    return { kind: 'silent' };
  }

  const t = thresholds(ctx.env);
  const now = deps.now ?? ctx.now;
  const start = now();
  for (;;) {
    const sig = deps.memory();
    if (sig.available_mb === null) return { kind: 'unknown', reason: `нет сигнала памяти: ${sig.missing_reason ?? 'available_mb = null'}`, gate: NAME };
    const closed = closedReason(sig, t);
    if (!closed) return { kind: 'silent' };
    const waitedMs = now() - start;
    if (waitedMs >= t.waitS * 1000) {
      const waitedS = Math.round(waitedMs / 1000);
      return {
        kind: 'deny', gate: NAME,
        reason: `ждал окно ${waitedS}с — не открылось (${closed}). Тяжёлую команду (${cls.heavy}) сейчас не запустить: закрой другие тяжёлые процессы или запускай последовательно и повтори.`,
      };
    }
    await deps.sleep(t.pollS * 1000);
  }
}

const gate: Gate = { name: NAME, events: ['pre-bash'], killSwitch: KILL_SWITCH, run: (ctx) => decide(ctx) };
register(gate);
