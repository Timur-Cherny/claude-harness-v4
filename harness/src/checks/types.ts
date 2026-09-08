// Контракт проверки файла. Проверки вызывает сверка дерева (src/sweep.ts) по изменённым файлам корней сессии:
// tier 'sync' — дёшево (bash -n, node --check, .claude/check.sh), бежит в самом событии под дедлайном;
// tier 'worker' — дорого (tsc, TS/SQL-AST по большому набору), уходит detached-воркеру, результат — следующим событием.
// Вердикт 'unknown' — нет инструмента/парсера/данных; он записывается в verified явно и никогда не считается pass (I1).
export interface ChangedFile {
  repo: string;      // корень git-репозитория (абсолютный путь)
  path: string;      // относительный путь от корня
  absPath: string;
  digest: string;    // sha256 содержимого (первые 16 hex)
  status: 'M' | 'A' | '?' | 'R' | 'C' | 'D' | 'U';
}

export interface CheckResult {
  verdict: 'pass' | 'fail' | 'unknown';
  message?: string;        // ≤ 4 КиБ, для findings/additionalContext; без содержимого файлов кроме строк-диагностик инструмента
  missing_reason?: string; // обязателен при unknown
}

export interface Checker {
  name: string;                       // = verified.checker
  tier: 'sync' | 'worker';
  killSwitch: string;                 // CLAUDE_SKIP_<NAME>
  applies(file: ChangedFile): boolean;
  run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult>;
}

export interface CheckContext {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  now: () => number;
  deadlineMs: number;   // сколько осталось у sync-яруса; воркер получает Infinity
}
