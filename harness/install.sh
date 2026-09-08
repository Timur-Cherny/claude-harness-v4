#!/bin/sh
# Единственный шаг zero-install: найти Node >= 24 и TypeScript, записать пути в ~/.claude/env/harness.env,
# создать симлинк ~/.claude/harness → этот каталог, прогреть compile cache, поставить WAL на базе состояния.
# Ничего не скачивает и не устанавливает. Повторный запуск идемпотентен. --clean сбрасывает compile cache.
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
envdir="$HOME/.claude/env"; envfile="$envdir/harness.env"
state="${CLAUDE_STATE_DIR:-$HOME/.claude/exec-telemetry}"
node_bin="${1:-}"
[ "$node_bin" = "--clean" ] && { rm -rf "$state/compile-cache"; echo "compile cache сброшен"; node_bin=""; }
[ "$node_bin" = "--node" ] && node_bin="${2:-}"
if [ -z "$node_bin" ]; then
  node_bin="$(CLAUDE_HARNESS_NODE= HOME="$HOME" sh -c '
    best=0; pick=""
    for cand in "$HOME"/.nvm/versions/node/v*/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
      [ -x "$cand" ] || continue
      v="$("$cand" -v 2>/dev/null)"; v="${v#v}"; maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"; pat="${rest#*.}"
      case "$maj$min$pat" in *[!0-9]*) continue ;; esac
      [ "$maj" -ge 24 ] || continue
      key=$(( maj * 1000000 + min * 1000 + pat )); [ "$key" -gt "$best" ] && { best=$key; pick="$cand"; }
    done; printf "%s" "$pick"')"
fi
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { echo "Node >= 24 не найден. Установи (nvm install 24) и повтори: install.sh --node /путь/к/node" >&2; exit 1; }
ts_lib=""
# Где искать TypeScript: каталог с чекаутами проектов задаётся HARNESS_TS_SEARCH (один префикс, не список),
# плюс глобальные модули nvm. Жёстких путей к конкретной машине здесь нет.
for d in "${HARNESS_TS_SEARCH:-}"/*/node_modules/typescript/lib/typescript.js "$HOME"/.nvm/versions/node/v*/lib/node_modules/typescript/lib/typescript.js; do
  [ -f "$d" ] && { ts_lib="$d"; break; }
done
mkdir -p "$envdir" "$state/compile-cache" "$state/markers"
{
  echo "# harness v4 — машинно-специфичный пин рантайма; вне git. Перегенерировать: harness/install.sh"
  echo "CLAUDE_HARNESS_NODE=$node_bin"
  [ -n "$ts_lib" ] && echo "CLAUDE_HARNESS_TS=$ts_lib"
} > "$envfile"
ln -sfn "$here" "$HOME/.claude/harness"
NODE_COMPILE_CACHE="$state/compile-cache" HARNESS_ROOT="$here" "$node_bin" --disable-warning=ExperimentalWarning "$here/src/main.ts" install-warmup </dev/null
echo "harness v4: node=$node_bin ts=${ts_lib:-нет} env=$envfile link=$HOME/.claude/harness"
