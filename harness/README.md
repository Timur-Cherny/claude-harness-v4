# harness v4 — детерминированный слой харнесса Claude Code

TypeScript под Node ≥ 24 без сборки и без `node_modules`. Решение и обоснование — [`../specs/ADR_HARNESS_V4_TS_NODE24.md`](../specs/ADR_HARNESS_V4_TS_NODE24.md);
что закрывает слой скиллов — [`../specs/HARNESS_V4_COVERAGE.md`](../specs/HARNESS_V4_COVERAGE.md).

## Подключение

```bash
sh harness/install.sh            # найти Node >= 24 и TypeScript, записать ~/.claude/env/harness.env, симлинк ~/.claude/harness
```

`settings.v4.json` — блок `hooks` для `~/.claude/settings.json`; `settings.repo.v4.json` — для `.claude/settings.json`
репозитория (вход через `.claude/bin/hook`, который выходит за 2–3 мс, если стоит user-level харнесс).
Node ≥ 24 не найден → на `PreToolUse` харнесс отвечает `ask` с причиной, на остальных событиях молчит и один раз
за сессию печатает `systemMessage`; `CLAUDE_HARNESS_UNKNOWN=note` превращает `ask` в `additionalContext`.

## Как устроено

| Путь | Роль |
|---|---|
| `bin/hook <event>` | единственная точка входа: пин Node (`$CLAUDE_HARNESS_NODE` → `harness.env` → `~/.nvm/…/v24+` → `node` ≥ 24 в PATH) и пин TypeScript (`CLAUDE_HARNESS_TS` — экспортируется, иначе структурные проверки молча дают `unknown`), `NODE_COMPILE_CACHE`, префильтр `pre-bash` по `bin/prefilter.regex` |
| `src/main.ts` | роутер: payload → гейты события (каждый в try/catch → `unknown(<имя>)`) → самый строгий вердикт → `emit()` |
| `src/emit.ts` | контракт выхода: `deny` rc 2 + stderr · `ask` JSON `permissionDecision` · `context` `additionalContext` · Stop `decision: block` · `unknown` → `ask` на pre, жёлтая строка на post |
| `src/state.ts` | `$CLAUDE_STATE_DIR/harness.db` (`node:sqlite`, WAL, `busy_timeout` первым): `verified`, `findings`, `deliveries`, `jobs`, `claims`, `stop_blocks`, `agent_window`, `markers`, … |
| `src/sweep.ts` | сверка дерева на каждом пишущем событии: `git status -z -uall` по корням сессии, sha256, сдвиг HEAD, ярусы проверок, доставка находок per-session |
| `src/checks/` | `syntax` (bash -n / node --check / py_compile / JSON), `project-check` (`.claude/check.sh <file>` проекта), `tsc-project` (воркер, только проектный `tsc`), структурные проверки |
| `src/jobs/worker.ts` | detached-воркер дорогих проверок; Stop дренирует незавершённые синхронно и блокируется до результата |
| `src/gates/` | гейты по событиям; реестр `registry.ts`, порядок — `index.ts` |
| `src/parsers/` | `shell.ts` — токенизатор закрытой грамматики; `sql.ts` — libpg_query 17 (WASM, `vendor/`, `VENDOR.lock`) |
| `src/journal.ts` | JSONL-журналы с белым списком полей на журнал (I3) |
| `src/platform.ts` | единственный модуль с платформой: `process.availableMemory`, `spawnTool` с allowlist |
| `test/` | `node --test`; `_env.ts` — песочницы (реальный `HOME`/`~/.claude` недостижимы); `bench/` (`HARNESS_BENCH=1`), `e2e/` (`HARNESS_E2E=1`, стоит токенов) |

События (`bin/hook <event>`): `pre-bash` `pre-agent` `pre-write` `post` `post-batch` `agent-start` `agent-stop` `stop`
`session-start` `session-end` `prompt` `precompact` `worktree-create` `worktree-remove` `contour-changed`.

## Выключатели

Каждый гейт и проверка гасятся своим `CLAUDE_SKIP_*=1` (читается роутером до любой записи). Список руками
не поддерживается — он печатается из реестра:

```sh
. ~/.claude/env/harness.env
"$CLAUDE_HARNESS_NODE" --disable-warning=ExperimentalWarning -e '
  await import("./src/gates/index.ts");
  const { GATES } = await import("./src/gates/registry.ts");
  const { CHECKERS } = await import("./src/checks/registry.ts");
  for (const g of [...GATES, ...CHECKERS]) console.log(g.name, g.killSwitch);'
```

Общего выключателя нет намеренно (I4): выключают один барьер, а не весь контур.

## Границы — что сверка не видит

Файлы под `.gitignore` (`.env`, `dist/`); деревья вне git (scratchpad); правки внутри контейнера/пода и в базе;
изменения после Stop до следующей сессии; деревья с числом изменённых файлов > 200 (сообщается `truncated`);
обфускация shell глубже одного уровня `sh -c`/`eval`, `base64 -d | sh`, команда из переменной — даёт `unknown`, не pass.
Here-doc в эти границы НЕ входит: тело `<<EOF` разбирается и судится (`git commit -F -`, `psql <<SQL`), а
`unknown` остаётся только там, где текст и правда неизвестен — подстановка в теле при голом ограничителе,
ограничитель без закрытия, here-string `<<<`, stdin из трубы.
Закоммиченный сломанный файл сообщается один раз при сдвиге HEAD, дальше это забота тестов проекта.

## Проверки

```bash
cd harness && . ~/.claude/env/harness.env                                    # пин Node 24 (в PATH может быть 22 — тогда .ts не запустится)
N="$CLAUDE_HARNESS_NODE"; F=--disable-warning=ExperimentalWarning
"$N" $F --test 'test/**/*.test.ts'                                           # macOS, Node 24
sh scripts/test-linux.sh                                                     # тот же сьют в docker node:24
HARNESS_BENCH=1 "$N" $F --test test/bench/latency.test.ts                    # медиана post ≤ 100 мс
HARNESS_E2E=1   "$N" $F --test test/e2e/headless.test.ts                     # живая claude -p, стоит токенов
```

Мета-тесты держат форму: `meta/lint` (strip-only синтаксис, запрещённые API), `meta/registry` (kill-switch у каждого гейта
встречается в тесте), `meta/bash-frozen` (оставшиеся `.sh` пинованы sha256 в `BASH_FROZEN.lock`), `meta/settings`
(каждая команда — `bin/hook <событие>`), `meta/vendor` (sha256 вендоренного парсера), `meta/prefilter` (шим = роутер).
