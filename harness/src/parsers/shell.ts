// Токенизатор shell-команд закрытой грамматики — единственный не-настоящий парсер контура.
// Граница объявлена: $(…) и `…` — непрозрачные токены; sh -c / bash -c / eval — один уровень
// рекурсии; глубже, незакрытые кавычки, here-string `<<<` — `unknown` с причиной. Гейт над
// результатом обязан трактовать unknown как «доказать безопасность нельзя», не как pass (I1).
//
// Here-doc РАЗБИРАЕТСЯ, а не объявляется непрозрачным: тело приходит в той же строке команды,
// поэтому «недоступно» было неправдой, а её цена — вечный ask на `git commit -F - <<EOF` и
// `psql <<SQL` (из-за него pg-барьер и выключали руками). Тело снимается с ограничителем,
// не попадает в поток токенов (иначе его строки становились бы отдельными командами) и
// кладётся в `heredocs` своего сегмента. Ограничитель в кавычках (`<<'EOF'`) = подстановок нет,
// тело literal. Голый (`<<EOF`) с `$`/бэктиком → `here-doc-expansion`: текст известен не весь.
// Ограничитель не встретился → `here-doc-unterminated`. Оба случая остаются unknown.
export interface Segment { argv: string[]; raw: string; depth: number; heredocs: string[]; unknown: string[] }
export interface ShellParse { segments: Segment[]; unknown: string[] }

const SEPARATORS = new Set([';', '\n', '|', '&', '(', ')']);
const PREFIX_SKIP = new Set(['command', 'exec', 'time', 'nohup', 'sudo', 'nice', 'ionice', 'stdbuf', 'timeout', 'gtimeout']);
const MAX_DEPTH = 1;

export function tokenize(cmd: string, depth = 0): ShellParse {
  const segments: Segment[] = [];
  const unknown: string[] = [];
  let segUnknown: string[] = [];
  let pending: HereDoc[] = [];
  let argv: string[] = [];
  let word = '';
  let hasWord = false;
  let segStart = 0;
  let i = 0;
  const n = cmd.length;

  const flushWord = () => { if (hasWord) { argv.push(word); word = ''; hasWord = false; } };
  const flushSeg = (end: number) => {
    flushWord();
    if (argv.length) segments.push({ argv, raw: cmd.slice(segStart, end).trim(), depth, heredocs: [], unknown: [...segUnknown] });
    unknown.push(...segUnknown);
    argv = []; segStart = end; segUnknown = [];
  };
  // Причина, найденная уже после закрытия сегмента (тело here-doc читается за его концом),
  // обязана попасть и в сегмент, и в общий список: гейт смотрит либо туда, либо туда.
  const noteAfter = (tag: string) => {
    const last = segments[segments.length - 1];
    if (last) last.unknown.push(tag);
    unknown.push(tag);
  };
  /** Тела ожидающих here-doc: от строки после `\n` до строки-ограничителя. Возвращает позицию за ней. */
  const consumeHeredocs = (start: number): number => {
    let pos = start;
    for (const h of pending) {
      const lines: string[] = [];
      let closed = false;
      while (pos <= n) {
        let eol = cmd.indexOf('\n', pos);
        const last = eol < 0;
        if (last) eol = n;
        const line = cmd.slice(pos, eol);
        const body = h.strip ? line.replace(/^\t+/, '') : line;
        pos = eol + 1;
        if (body === h.delim) { closed = true; break; }
        lines.push(body);
        if (last) break;
      }
      const text = lines.length ? lines.join('\n') + '\n' : '';
      const target = segments[segments.length - 1];
      if (target) target.heredocs.push(text); else unknown.push('here-doc-orphan');
      if (!closed) noteAfter('here-doc-unterminated');
      else if (h.expand && /[$`]/.test(text)) noteAfter('here-doc-expansion');
    }
    pending = [];
    return Math.min(pos, n);
  };

  while (i < n) {
    const ch = cmd[i];
    if (ch === '\\' && i + 1 < n) { word += cmd[i + 1]; hasWord = true; i += 2; continue; }
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) { segUnknown.push('unterminated-single-quote'); word += cmd.slice(i + 1); hasWord = true; i = n; break; }
      word += cmd.slice(i + 1, j); hasWord = true; i = j + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1; let buf = '';
      while (j < n && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < n) { buf += cmd[j + 1]; j += 2; continue; }
        if (cmd[j] === '$' && cmd[j + 1] === '(') { const k = matchParen(cmd, j + 1); segUnknown.push('command-substitution'); buf += cmd.slice(j, k + 1); j = k + 1; continue; }
        if (cmd[j] === '`') { const k = cmd.indexOf('`', j + 1); segUnknown.push('command-substitution'); if (k < 0) { buf += cmd.slice(j); j = n; break; } buf += cmd.slice(j, k + 1); j = k + 1; continue; }
        buf += cmd[j]; j++;
      }
      if (j >= n) segUnknown.push('unterminated-double-quote');
      word += buf; hasWord = true; i = Math.min(j + 1, n); continue;
    }
    if (ch === '$' && cmd[i + 1] === '(') { const k = matchParen(cmd, i + 1); segUnknown.push('command-substitution'); word += cmd.slice(i, k + 1); hasWord = true; i = k + 1; continue; }
    if (ch === '`') { const k = cmd.indexOf('`', i + 1); segUnknown.push('command-substitution'); if (k < 0) { word += cmd.slice(i); hasWord = true; i = n; break; } word += cmd.slice(i, k + 1); hasWord = true; i = k + 1; continue; }
    if (ch === '<' && cmd[i + 1] === '<') {
      flushWord();
      if (cmd[i + 2] === '<') { segUnknown.push('here-string'); i += 3; continue; }
      let j = i + 2;
      const strip = cmd[j] === '-'; if (strip) j++;
      while (j < n && (cmd[j] === ' ' || cmd[j] === '\t')) j++;
      const d = readDelimiter(cmd, j);
      if (!d) { segUnknown.push('here-doc'); i = j; continue; }
      pending.push({ delim: d.delim, strip, expand: d.expand });
      i = d.next; continue;
    }
    if (ch === '#' && !hasWord) { const j = cmd.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (SEPARATORS.has(ch)) {
      // `&&`, `||`, `|&`, `2>&1` (амперсанд после `>` — не фон)
      if (ch === '&' && i > 0 && cmd[i - 1] === '>') { word += ch; hasWord = true; i++; continue; }
      flushSeg(i);
      if (ch === '\n' && pending.length) { i = consumeHeredocs(i + 1); segStart = i; continue; }
      while (i < n && SEPARATORS.has(cmd[i])) i++;
      segStart = i; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flushWord(); i++; continue; }
    word += ch; hasWord = true; i++;
  }
  flushSeg(n);
  if (pending.length) { pending = []; noteAfter('here-doc-unterminated'); }

  // Один уровень вложенности: sh -c "…" / bash -c "…" / eval … / скрипт, поданный оболочке here-doc'ом.
  // Тело идёт в разбор ТОЛЬКО у оболочки: у `psql <<SQL` тело — это SQL, и читать его как shell значит
  // выдумывать команды (`npm run build` в тексте документа стало бы «тяжёлой командой»).
  const expanded: Segment[] = [];
  for (const seg of segments) {
    expanded.push(seg);
    const { name, rest } = effective(seg.argv);
    const isShell = name === 'sh' || name === 'bash' || name === 'zsh' || name === 'dash';
    const inners: string[] = [];
    if (isShell && rest.includes('-c')) { const v = rest[rest.indexOf('-c') + 1]; if (v !== undefined) inners.push(v); }
    if (name === 'eval') inners.push(rest.join(' '));
    if (isShell) inners.push(...seg.heredocs);
    if (!inners.length) continue;
    if (depth >= MAX_DEPTH) { unknown.push('nested-shell-depth'); continue; }
    for (const inner of inners) {
      const sub = tokenize(inner, depth + 1);
      expanded.push(...sub.segments); unknown.push(...sub.unknown);
    }
  }
  return { segments: expanded, unknown: [...new Set(unknown)] };
}

interface HereDoc { delim: string; strip: boolean; expand: boolean }

/** Ограничитель here-doc: `EOF`, `'EOF'`, `"EOF"`, `\EOF`. Кавычка/экранирование = подстановок в теле нет. */
function readDelimiter(s: string, from: number): { delim: string; expand: boolean; next: number } | null {
  let i = from;
  let delim = '';
  let quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { const k = s.indexOf(c, i + 1); if (k < 0) return null; delim += s.slice(i + 1, k); quoted = true; i = k + 1; continue; }
    if (c === '\\' && i + 1 < s.length) { delim += s[i + 1]; quoted = true; i += 2; continue; }
    if (/[\s;|&<>()]/.test(c)) break;
    delim += c; i++;
  }
  return delim ? { delim, expand: !quoted, next: i } : null;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') { depth--; if (depth === 0) return k; }
  }
  return s.length - 1;
}

/** Имя команды сегмента после префиксов `VAR=v`, `env -u X`, `command`, `sudo`, `time`, `timeout N`. */
export function effective(argv: string[]): { name: string; rest: string[] } {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (t === 'env') { i++; while (i < argv.length && (argv[i] === '-u' || argv[i] === '-i' || argv[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]))) { i += argv[i] === '-u' ? 2 : 1; } continue; }
    if (PREFIX_SKIP.has(t)) { i++; if ((t === 'timeout' || t === 'gtimeout' || t === 'nice') && /^[-\d]/.test(argv[i] ?? '')) i++; continue; }
    break;
  }
  return { name: argv[i] ?? '', rest: argv.slice(i + 1) };
}

/** Команды всех сегментов (в том числе внутри sh -c). */
export function commands(parse: ShellParse): Array<{ name: string; argv: string[]; rest: string[]; depth: number }> {
  return parse.segments.map((s) => { const e = effective(s.argv); return { name: e.name, argv: s.argv, rest: e.rest, depth: s.depth }; });
}

/** Слово встречается как отдельный токен в любом сегменте (kubectl exec pod -- psql …). */
export function mentions(parse: ShellParse, word: string | RegExp): boolean {
  const re = word instanceof RegExp ? word : new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return parse.segments.some((s) => s.argv.some((t) => re.test(t) || re.test(t.split('/').pop() ?? t)));
}
