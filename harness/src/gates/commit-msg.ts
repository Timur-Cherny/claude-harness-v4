// PreToolUse(Bash) `git commit`: сообщение коммита без следов AI-инструментов (порт hooks/commit-msg-guard.sh).
// Команда разбирается токенизатором и git-argv (`cd X &&`, `git -C X`); сообщение берётся из `-m`/`--message`
// и — в отличие от bash-оригинала, у которого это названная дыра — читается из файла `-F`/`--file`.
// `git commit -F - <<EOF` разбирается: тело here-doc снимает токенизатор, и сообщение читается как из файла.
// Раньше эта форма давала unknown → ask на каждый коммит; «недоступно» было неправдой — тело лежит в той же
// строке команды. Остаются unknown: stdin без here-doc (`… | git commit -F -`), `<<EOF` с подстановкой,
// незакрытый ограничитель, `$(…)`, cd по неизвестной переменной.
// Regex ATTRIBUTION применяется к сообщению коммита — тексту без грамматики (PORTING: допустимо); когда
// источник непрозрачен, он же применяется к сырому тексту команды: видимая атрибуция — доказанное
// нарушение, а не «нет данных».
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { register } from './registry.ts';
import { tokenize } from '../parsers/shell.ts';
import { segmentsWithCwd, parseGit, isGit } from './git-argv.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'commit-msg-guard';
const ATTRIBUTION = /co-authored-by:[^\n]*(claude|anthropic)|noreply@anthropic\.com|generated with[^\n]*claude|claude-session:|🤖/i;
const DENY_TEXT = 'в коммит-месседже AI-атрибуция (Co-Authored-By Claude/Anthropic, noreply@anthropic.com, «Generated with Claude», Claude-Session или 🤖). Правило юзера: коммиты без следов AI. Убери эти строки из сообщения и повтори коммит.';
// Короткие опции commit со значением: кластер `-am x` читается слева направо, первая такая опция забирает остаток.
const VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't']);
const VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--cleanup', '--trailer']);

interface MessageSources { messages: string[]; files: string[] }

function messageSources(args: string[]): MessageSources {
  const messages: string[] = []; const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a : a.slice(0, eq);
      let val: string | undefined;
      if (eq >= 0) val = a.slice(eq + 1);
      else if (VALUE_LONG.has(key)) val = args[++i];
      if (key === '--message') messages.push(val ?? '');
      else if (key === '--file') files.push(val ?? '');
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (!VALUE_SHORT.has(ch)) continue;
        const val = a.slice(j + 1) || (args[++i] ?? '');
        if (ch === 'm') messages.push(val); else if (ch === 'F') files.push(val);
        break;
      }
    }
  }
  return { messages, files };
}

const unknown = (reason: string): Verdict => ({ kind: 'unknown', gate: NAME, reason });
const DENY: Verdict = { kind: 'deny', gate: NAME, reason: DENY_TEXT };

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload;
  if (!('tool_name' in p) || p.tool_name !== 'Bash') return { kind: 'silent' };
  const command = (p.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string' || !command.trim()) return { kind: 'silent' };
  const parse = tokenize(command);
  for (const seg of segmentsWithCwd(parse, p.cwd, ctx.env)) {
    if (!isGit(seg.name)) continue;
    const call = parseGit(seg.rest, seg.cwd, ctx.env);
    if (!call || call.verb !== 'commit') continue;
    const src = messageSources(call.args);
    const opaque = [...seg.unknown];
    const texts = [...src.messages];
    // `-F -` со своим here-doc — читаемый источник; без него на stdin приходит чужой вывод.
    for (const f of src.files) {
      if (f !== '-') continue;
      if (seg.heredocs.length && !opaque.length) texts.push(seg.heredocs.join('\n'));
      else opaque.push('stdin');
    }
    if (opaque.length) {
      if (ATTRIBUTION.test(command)) return DENY;
      return unknown(`сообщение коммита не прочитать (${opaque.join(', ')}): проверить нечего, доказать чистоту нельзя`);
    }
    for (const f of src.files) {
      if (f === '-') continue;
      if (call.cwd === null && !isAbsolute(f)) return unknown(`каталог для файла сообщения ${f} не определён (cd по неизвестной переменной)`);
      try { texts.push(readFileSync(resolve(call.cwd ?? '/', f), 'utf8')); }
      catch (e) { return unknown(`файл сообщения ${f} не прочитан: ${(e as Error).message.split('\n')[0]}`); }
    }
    if (ATTRIBUTION.test(texts.join('\n\n'))) return DENY;
  }
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['pre-bash'], killSwitch: 'CLAUDE_SKIP_COMMIT_GUARD', run: decide };
register(gate);
