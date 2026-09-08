# Порт хука в harness v4 — конвенции для исполнителя

Читать целиком до первой строки кода. Всё, что здесь не разрешено, — запрещено.

## Что уже есть (не трогать, только импортировать)

- `src/types.ts` — `HookPayload` (по пробе: у `PostToolUse(Bash)` нет `exit_code`; неуспех — `PostToolUseFailure.error = "Exit code N\n…"`), `Verdict`, `Gate`, `GateContext`.
- `src/emit.ts` — единственный контракт выхода (I8). Гейт возвращает `Verdict`, НЕ пишет в stdout/stderr, НЕ вызывает `process.exit`.
- `src/gates/registry.ts` — `register(gate)`; гейт регистрируется побочным эффектом импорта своего модуля. Импорт в `src/gates/index.ts` добавляет интегратор, не ты.
- `src/state.ts` — `State.open(stateDir)`, `tx()`, `claim()`, `marker()/setMarker()`; таблицы объявлены в `SCHEMA`. Новая таблица — только через правку `SCHEMA` + `SCHEMA_VERSION` (вперёд-совместимо: `CREATE TABLE IF NOT EXISTS`/`ADD COLUMN`).
- `src/journal.ts` — `appendJsonl(path, journal, record)` с белым списком ключей на журнал. Новое поле — осознанная правка `WHITELIST` + строка в отчёте «почему это метка, а не содержимое».
- `src/platform.ts` — `memory()`, `swap()`, `spawnTool(bin, args, opts)` (allowlist). **Единственная точка запуска внешних бинарей.** Прямые `execSync`/`spawn`/`child_process` в `src/gates`, `src/checks`, `src/session` запрещены.
- `src/parsers/shell.ts` — `tokenize(cmd)`, `commands(parse)`, `mentions(parse, word)`, `effective(argv)`; `parse.unknown[]` непуст → доказать безопасность нельзя → `unknown`.
- `src/parsers/sql.ts` — `parseSql(text)` → AST libpg_query (vendor). Ошибка разбора → `{ error }`, не исключение.
- `test/_env.ts` — `sandbox()`, `runHook()`, `payload()`, `bashPayload()`, `fakeNode()`; тесты НИКОГДА не касаются реального `HOME`/`~/.claude`.

## Форма гейта

```ts
import { register } from './registry.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';
export const NAME = 'model-gate';
export function decide(ctx: GateContext): Verdict { /* чистая функция над (payload, env, state) */ }
register({ name: NAME, events: ['pre-agent'], killSwitch: 'CLAUDE_SKIP_MODEL_GATE', run: decide });
```

- Имена kill-switch сохраняются из bash-оригинала (`CLAUDE_SKIP_MODEL_GATE`, `CLAUDE_SKIP_COMMIT_GUARD`, `CLAUDE_SKIP_PREPUSH_GUARD`, `CLAUDE_SKIP_RESOURCE_GUARD`, `CLAUDE_SKIP_PG_SESSION_GUARD`, `CLAUDE_SKIP_FRICTION_GATE`, `CLAUDE_SKIP_MEMORY_INTEGRITY`, `CLAUDE_SKIP_FRICTION`, `CLAUDE_SKIP_AI_USAGE`, `CLAUDE_SKIP_TREE_SWEEP`, `CLAUDE_SKIP_CHECK`). Роутер читает выключатель ДО вызова `run` — внутри гейта его не проверять.
- Вердикты: `deny` — доказанное нарушение; `ask` — не доказать безопасность на pre; `unknown` — нет данных/парсер не разобрал/нет git (роутер сам поднимет до ask или context); `context` — advisory; `silent` — норма. Никаких `console.log`.
- Regex по SQL/TS/JS запрещён (класс К1). SQL — только `parseSql`; TS/JS — только compiler API из `node_modules/typescript` ближайшего вверх от файла (`createRequire`), при отсутствии — `unknown`. Regex допустим только для строк без грамматики (сообщение коммита, имена веток, имя файла) — и это надо назвать в шапке модуля.
- Платформа: `os.freemem`, `vm_stat`, `sysctl`, `stat -f`, `date -j`, `jq`, `python3 -c`, `perl`, `shasum` запрещены. Память — `platform.memory()`, своп — `platform.swap()`, хеши — `node:crypto`, время — `ctx.now()`.
- Node 24 type-stripping: никаких `enum`, `namespace`, parameter properties, `import x = require`; type-only импорты через `import type`; относительные импорты с расширением `.ts`.

## Форма теста (`test/gates/<name>.test.ts`, `node:test`)

- Шапка файла: что молча ломалось + `INVARIANT:`/`REGRESSION:`; имя `it` — утверждение о поведении (без should).
- Обе стороны: каждый deny-кейс из bash-корпуса и каждый allow-кейс; отрицательная сторона — по РАЗНЫМ причинам.
- Кейс `unknown`: парсер недоступен / не разобрал / вне git → вердикт `unknown` с причиной, не silent.
- Кейс kill-switch — через `route()` из `src/main.ts` с `env[KILL]='1'`: вердикт silent И никаких записей в состояние/журнал (проверить файлы sandbox).
- Кейсы переносятся из `hooks/spec/<name>.test.sh` один в один + новые обходы, названные в задаче. Фикстуры payload — как в пробе (`test/_env.ts`).
- Тест не запускает реальные `git push`/`psql`/`docker`; git-репозитории — временные (`sandbox()` + `git init`).
- Прогон: `node --disable-warning=ExperimentalWarning --test test/gates/<name>.test.ts` из каталога `harness/`. Красный до правки обязателен там, где переносится известный обход (показать блок).

## Отчёт исполнителя

Список файлов; команда прогона и итог (`pass N fail 0`); таблица «кейс bash → кейс TS» с отметкой новых; расхождения с bash-оригиналом (намеренные — с причиной); что НЕ перенесено и почему; секция `## Трение`.

## Форма проверки файла (для структурных проверок: comment-bloat, tripwire, язык комментариев, pg-in-file)

`src/checks/types.ts` — `Checker { name, tier: 'sync'|'worker', killSwitch, applies(file), run(file, ctx) → CheckResult }`;
регистрация `registerChecker()` из `src/checks/registry.ts` побочным эффектом импорта модуля `src/checks/<name>.ts`.
Проверка получает `ChangedFile` (repo, path, absPath, digest) и возвращает `pass|fail|unknown`; читает файл сама.
Добавленные строки для «только новое» — через `spawnTool('git', ['diff','-U0','--', path], {cwd: repo})` и
`git diff -U0 --cached`; для untracked файла добавлены все строки. TS — `createSourceFile` из `node_modules/typescript`
ближайшего вверх от `absPath` (`createRequire`); нет — `unknown` с `missing_reason`. Тест — `test/checks/<name>.test.ts`:
временный git-репозиторий, файл с нарушением → fail, без нарушения → pass, без typescript → unknown.
