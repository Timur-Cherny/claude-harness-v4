# Claude Code Harness v4

Детерминированный слой проверок для Claude Code: TypeScript под Node 24, без сборки и без `node_modules`.

## Зачем

Планка качества держится машинерией и не зависит от того, какая модель подключена: сильная проходит её
быстрее, слабая — дольше и дороже, но не хуже. Проверка любого элемента контура: *если качество зависит от
того, насколько умна модель, элемент спроектирован неверно.*

Отсюда четыре свойства:

- **проверка висит на состоянии рабочего дерева, а не на событии инструмента** — правка любой дверью
  (`Write`, `sed`, heredoc, `python -c`, `git apply`, MCP, субагент) видна одинаково;
- **вердикт выносят парсеры, а не regex** — SQL разбирает libpg_query, TypeScript — compiler API проекта,
  команду — токенизатор закрытой грамматики;
- **отсутствие данных — это `unknown`, а не тишина и не `pass`**; на pre-событиях `unknown` поднимается
  до `ask` (`harness/src/emit.ts`);
- **один язык, один процесс на событие, один контракт выхода**.

Устройство контура целиком — [`harness/README.md`](harness/README.md). Конвенции для тех, кто пишет новый
гейт, — [`harness/PORTING.md`](harness/PORTING.md).

## Установка (macOS и Linux)

Нужен **Node ≥ 24**. TypeScript желателен: без него проверки содержимого честно отвечают `unknown`.

```sh
git clone <этот-репозиторий> ~/src/claude-harness
cd ~/src/claude-harness

# 1. Пин рантайма, симлинк ~/.claude/harness, прогрев compile cache. Ничего не скачивает.
harness/install.sh

# 2. Подключить события. Если своего ~/.claude/settings.json ещё нет:
ln -s "$PWD/settings.json" ~/.claude/settings.json
#    Если есть — перенеси в него блок "hooks" из harness/settings.v4.json целиком.

# 3. Необязательно: настройка площадки (защищённые ветки, конвенция work-doc, путь вольта).
cp harness/harness.config.example.json ~/.claude/harness.config.json
```

Проверить, что встало:

```sh
cd harness && node --test 'test/**/*.test.ts'     # 617 тестов
```

`install.sh` ищет TypeScript в глобальных модулях nvm и в `$HARNESS_TS_SEARCH/*/node_modules`. Найденный путь
пишется в `~/.claude/env/harness.env` вместе с пином Node; этот файл машинно-специфичный и вне git.

## Без конфига контур работает

Файла `~/.claude/harness.config.json` может не быть — это обычная новая машина, а не ошибка:

| Что | Без конфига |
|---|---|
| Защищённые ветки | `main` — прямой push и MR только с `release/*` либо `hotfix/*` |
| Напоминание о work-doc | молчит: чужая конвенция не навязывается |
| Путь вольта для `git-freshness` | дефолтного нет, проверяются только явно заданные пути |

Битый JSON или поле не того типа — тоже дженерик-дефолты, а не падение: конфиг описывает удобство, и ронять
из-за него каждое событие дороже. Разбор — `harness/src/config.ts`, проверки — `harness/test/config.test.ts`.

## Что внутри

| Путь | Роль |
|---|---|
| `harness/bin/hook` | единственный вход из `settings.json`: пин Node, `NODE_COMPILE_CACHE`, префильтр `pre-bash` без запуска Node |
| `harness/src/gates/` | гейты по событиям; реестр `registry.ts` |
| `harness/src/checks/` | ярусные проверки изменённого файла (syntax, project-check, tsc, комментарии, tripwire) |
| `harness/src/parsers/` | токенизатор shell, libpg_query для SQL, compiler API для TypeScript |
| `harness/src/state.ts` | `node:sqlite` (WAL): подтверждения, находки, окна агентов, задания |
| `settings.json` · `.claude/settings.json` | привязка событий: user-level и repo-level |
| `agents/` · `skills/` | субагенты и сквозные скиллы дисциплины доказательства |

Состав гейтов не поддерживается руками — он печатается из реестра:

```sh
cd harness && node --disable-warning=ExperimentalWarning -e '
  await import("./src/gates/index.ts");
  const { GATES } = await import("./src/gates/registry.ts");
  for (const g of GATES) console.log(g.name.padEnd(24), g.killSwitch.padEnd(30), g.events.join(","));'
```

У каждого гейта свой выключатель `CLAUDE_SKIP_*=1`; общего выключателя нет намеренно.

## Границы

- Контур проверяет то, что видит в рабочем дереве и в аргументах команд. Доступ в обход этого (например, поход
  в базу через `kubectl exec`) он по построению не отбивает: граница правила шире границы гейта.
- `harness/hooks`-слоя здесь нет: bash-версии v2/v3 остались в приватной истории автора и к событиям не
  подключены.
- Проверки содержимого без TypeScript отвечают `unknown`, а не `pass`. Это видно в выводе, но означает, что
  на машине без TypeScript часть контура не работает — поставь его.
