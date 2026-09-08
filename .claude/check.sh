#!/usr/bin/env bash
# ПОФАЙЛОВАЯ проверка vault/claude. Вызывается changed-file-check.sh ($1 = файл)
# и сверкой дерева на Stop. Ненулевой выход = провал, вывод уходит модели.
#
# Уровневые проверки репозитория (инвентарь README, расписание) сюда НЕ входят.
# Раньше входили и стояли первыми: любой их дрейф делал `exit 1` до пофайловой
# части, и она не выполнялась вообще. Их место — SessionStart и сверка дерева.
set -uo pipefail

f="${1:-}"; [ -n "$f" ] && [ -f "$f" ] || exit 0
fail=0

case "$(basename "$f")" in
  *.sh)
    bash -n "$f" || fail=1
    exit "$fail"
    ;;
  worklog.md) ;;
  *) exit 0 ;;
esac

# ---- worklog-lint ----
LEGEND='**Статусы:** ✅ done · 🔵 in progress · 🟡 started · ⏸ parked. Записи ЖИВЫЕ — рефакторить при изменении, не дублировать.'
if ! grep -qxF "$LEGEND" "$f"; then
  echo "worklog-lint: легенда статусов изменена или исчезла. Канон (байт-в-байт):"
  echo "  $LEGEND"
  fail=1
fi

# Скобка сразу после статуса — маркер replace-all-порчи: хвост приклеивается
# к каждому вхождению статуса, а не к одной записи. Детали статуса — в тело.
bad="$(grep -nE '^#{2,3} .*(✅|🔵|🟡|⏸)( (done|in progress|started|parked))? \(' "$f" || true)"
if [ -n "$bad" ]; then
  echo "worklog-lint: скобочный хвост после статуса в заголовке — статус держим чистым, детали в тело записи:"
  printf '%s\n' "$bad" | head -12 | sed 's/^\([0-9]*\):/  L\1: /' | cut -c1-200
  fail=1
fi

exit "$fail"
