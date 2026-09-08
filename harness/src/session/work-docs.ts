// UserPromptSubmit: промпт с намерением «задокументировать / как работает …» в репозитории, где принята
// конвенция work-doc → напоминание зафиксировать объяснение в вольте, не только в чате. Молчит вне совпадения.
// Regex здесь — по строкам без грамматики: путь cwd и текст промпта пользователя.
//
// Площадка (какие репозитории и какой текст) жила в коде и тащила за собой имена репозиториев и путь вольта,
// из-за чего контур нельзя было отдать на чужую машину. Теперь она в конфиге: `workDocs` не задан — гейт
// молчит. Намерение (INTENT) остаётся в коде: это свойство языка, а не площадки.
import { register } from '../gates/registry.ts';
import { loadConfig } from '../config.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'work-docs-reminder';
export const KILL = 'CLAUDE_SKIP_WORK_DOCS';

export const INTENT = /документ|задокумент|vault|obsidian|work-?doc|ворк-?док|опиши .*(бизнес|систем|работает|флоу)|как (работает|устроен|обрабатыва)|запиши .*(документ|память)/;

export function decide(ctx: GateContext): Verdict {
  const wd = loadConfig(ctx.env).workDocs;
  if (!wd) return { kind: 'silent' }; // конвенция площадки не настроена — напоминать не о чем
  let cwdRe: RegExp;
  try {
    cwdRe = new RegExp(wd.cwd);
  } catch {
    return { kind: 'silent' }; // битый regex в конфиге не должен ронять каждый промпт
  }
  if (!cwdRe.test(ctx.payload.cwd)) return { kind: 'silent' };
  const prompt = (ctx.payload as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string') return { kind: 'unknown', reason: 'в payload нет prompt — намерение не проверить', gate: NAME };
  return INTENT.test(prompt.toLowerCase()) ? { kind: 'context', text: wd.text, gate: NAME } : { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['prompt'], killSwitch: KILL, run: decide };
register(gate);
