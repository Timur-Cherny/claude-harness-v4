// Единственный модуль, знающий платформу (R4/К3). Память — process.availableMemory(): os.freemem()
// на macOS показывает свободные страницы (74 MB при 4,6 GB доступных) и превращает любой порог
// в стену. Своп — /proc/meminfo на linux; на darwin — только по явному запросу и через spawnTool.
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface MemorySignal { available_mb: number | null; constrained_mb: number | null; load_per_core: number; missing_reason?: string }
export interface SwapSignal { used_mb: number | null; missing_reason?: string }

export function memory(): MemorySignal {
  const avail = typeof process.availableMemory === 'function' ? process.availableMemory() : null;
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 1;
  const load = os.loadavg()[0] / cores;
  if (avail === null) return { available_mb: null, constrained_mb: null, load_per_core: load, missing_reason: 'process.availableMemory недоступен' };
  return { available_mb: Math.round(avail / 1048576), constrained_mb: constrained ? Math.round(constrained / 1048576) : null, load_per_core: load };
}

const SPAWN_ALLOW = new Set(['sysctl', 'git', 'bash', 'node', 'tsc', 'npx', 'python3', 'sh']);

/** Единственная точка запуска внешних инструментов: allowlist, без оболочки, с таймаутом. */
export function spawnTool(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): { rc: number; stdout: string; stderr: string } {
  if (!SPAWN_ALLOW.has(bin)) throw new Error(`spawnTool: ${bin} вне allowlist`);
  try {
    const stdout = execFileSync(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 10000, input: opts.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 << 20, env: opts.env ?? process.env });
    return { rc: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; killed?: boolean };
    return { rc: err.killed ? 124 : (err.status ?? 1), stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

export function swap(procMeminfo = '/proc/meminfo'): SwapSignal {
  if (process.platform === 'linux') {
    try {
      const txt = readFileSync(procMeminfo, 'utf8');
      const total = Number(/SwapTotal:\s+(\d+)/.exec(txt)?.[1] ?? NaN), free = Number(/SwapFree:\s+(\d+)/.exec(txt)?.[1] ?? NaN);
      if (Number.isNaN(total) || Number.isNaN(free)) return { used_mb: null, missing_reason: 'SwapTotal/SwapFree не найдены' };
      return { used_mb: Math.round((total - free) / 1024) };
    } catch (e) { return { used_mb: null, missing_reason: `meminfo: ${(e as Error).message.split('\n')[0]}` }; }
  }
  if (process.platform === 'darwin') {
    const r = spawnTool('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 3000 });
    const m = /used = ([\d.]+)([MG])/.exec(r.stdout);
    if (r.rc !== 0 || !m) return { used_mb: null, missing_reason: 'sysctl vm.swapusage не ответил' };
    return { used_mb: Math.round(Number(m[1]) * (m[2] === 'G' ? 1024 : 1)) };
  }
  return { used_mb: null, missing_reason: `платформа ${process.platform} не поддержана` };
}
