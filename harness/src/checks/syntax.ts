// Синхронный ярус: синтаксис по расширению — bash -n, node --check, python -m py_compile, JSON.parse.
// Порт диспетчера hooks/changed-file-check.sh:92-135. Инструмента нет → unknown с причиной, не pass.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { spawnTool } from '../platform.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult } from './types.ts';

const EXT: Record<string, 'sh' | 'js' | 'py' | 'json'> = { '.sh': 'sh', '.bash': 'sh', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.py': 'py', '.json': 'json' };

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && extname(file.path) in EXT; }

export async function run(file: ChangedFile, _ctx: CheckContext): Promise<CheckResult> {
  const kind = EXT[extname(file.path)];
  if (kind === 'json') {
    try { JSON.parse(readFileSync(file.absPath, 'utf8')); return { verdict: 'pass' }; }
    catch (e) { return { verdict: 'fail', message: `${file.path}: ${(e as Error).message.split('\n')[0]}` }; }
  }
  const spec = kind === 'sh' ? ['bash', ['-n', file.absPath]] as const
    : kind === 'js' ? ['node', ['--check', file.absPath]] as const
    : ['python3', ['-m', 'py_compile', file.absPath]] as const;
  const r = spawnTool(spec[0], [...spec[1]], { timeoutMs: 10000, cwd: file.repo, env: _ctx.env });
  if (r.rc === 127 || /not found|ENOENT/.test(r.stderr)) return { verdict: 'unknown', missing_reason: `${spec[0]} недоступен` };
  if (r.rc === 124) return { verdict: 'unknown', missing_reason: `${spec[0]} превысил таймаут` };
  if (r.rc !== 0) return { verdict: 'fail', message: `${file.path}: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 6).join('\n')}`.slice(0, 4096) };
  return { verdict: 'pass' };
}

registerChecker({ name: 'syntax', tier: 'sync', killSwitch: 'CLAUDE_SKIP_CHECK', applies, run });
