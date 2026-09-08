// memory-guard — событие Stop: голодание памяти. Никогда не блокирует — advisory (`context`) при
// голодании, тишина при норме, `unknown` когда сигналов нет (I1: нет данных ≠ здорово).
// История bash-оригинала (25.07.2026): редакция «free+inactive» молчала три часа зависания; редакция
// «free и абсолютный своп» кричала на здоровой машине с 1,6 GB давно занятого свопа (шрам инцидента).
// Сигнал — ПРИРОСТ свопа с прошлой проверки и доступная память сейчас, не абсолютные величины.
// Память — platform.memory() (process.availableMemory: свободные + переиспользуемые страницы), а не
// os.freemem (69 MB при 4,6 GB доступных). Прошлое значение свопа — маркер в State (одна база на машину),
// вместо файла ~/.claude/.memory-guard-swap. Компрессор (vm_stat) и «едоки» (top) не переносятся:
// платформа этих инструментов не даёт, а regex по их выводу — тот же класс ошибок.
import { register } from '../gates/registry.ts';
import { memory as platformMemory, swap as platformSwap, type MemorySignal, type SwapSignal } from '../platform.ts';
import { State } from '../state.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'memory-guard';
export const KILL_SWITCH = 'CLAUDE_SKIP_MEMORY_GUARD';
export const FREE_FLOOR_MB = 200;
export const SWAP_GROWTH_MAX_MB = 200;
export const MARKER_KEY = 'memory-guard.swap_used_mb';

export interface MemoryGuardDeps {
  memory: () => MemorySignal;
  swap: () => SwapSignal;
}

export const defaults: MemoryGuardDeps = { memory: platformMemory, swap: platformSwap };

/** Прирост свопа относительно прошлой остановки; первый замер — точка отсчёта, прирост 0. */
export function swapGrowth(stateDir: string, usedMb: number, at: number): number {
  const st = State.open(stateDir);
  try {
    return st.tx(() => {
      const prev = st.marker(MARKER_KEY);
      st.setMarker(MARKER_KEY, String(usedMb), at);
      return prev === null ? 0 : usedMb - Number(prev);
    });
  } finally { st.close(); }
}

export function decide(ctx: GateContext, deps: MemoryGuardDeps = defaults): Verdict {
  const mem = deps.memory();
  const sw = deps.swap();
  const missing: string[] = [];
  const starved: string[] = [];

  if (mem.available_mb === null) missing.push(`память: ${mem.missing_reason ?? 'available_mb = null'}`);
  else if (mem.available_mb < FREE_FLOOR_MB) starved.push(`доступно ${mem.available_mb}MB (порог ${FREE_FLOOR_MB}MB)`);

  if (sw.used_mb === null) missing.push(`своп: ${sw.missing_reason ?? 'used_mb = null'}`);
  else {
    const growth = swapGrowth(ctx.stateDir, sw.used_mb, ctx.now());
    if (growth > SWAP_GROWTH_MAX_MB) starved.push(`своп вырос на ${growth}MB с прошлой проверки (порог ${SWAP_GROWTH_MAX_MB}MB)`);
  }

  if (starved.length) {
    return {
      kind: 'context', gate: NAME,
      text: `⚠️ memory-guard: машина голодает — ${starved.join('; ')}. Следующая тяжёлая команда, скорее всего, повиснет на своп-вводе (случай 25.07: три чтения одного файла не уложились в 2 минуты).`,
    };
  }
  if (missing.length) return { kind: 'unknown', reason: `нет сигнала — ${missing.join('; ')}`, gate: NAME };
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['stop'], killSwitch: KILL_SWITCH, run: decide };
register(gate);
