#!/bin/sh
# R4: тот же сьют обязан быть зелёным на linux. typescript ставится в контейнер и адресуется CLAUDE_HARNESS_TS:
# без него проверки содержимого отвечают unknown, и сьют краснеет 93 тестами по одной причине. Запуск в контейнере node:24 (colima/docker), исходники — read-only bind,
# HOME и CLAUDE_STATE_DIR — внутри контейнера. Память wms-db-spec-docker-socket: DOCKER_HOST может указывать на colima.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
# Монтируется КОРЕНЬ репозитория, а не harness/: тесты расписания и сессии читают specs/ и hooks/ уровнем выше,
# и при монтировании одного harness/ падали на ENOENT /specs/schedule.json — 25 красных по одной причине.
repo="$(cd "$here/.." && pwd -P)"
docker run --rm -v "$repo":/repo:ro -w /repo/harness -e HOME=/tmp/home -e CLAUDE_STATE_DIR=/tmp/state node:24 \
  sh -c 'mkdir -p /tmp/home /tmp/state && apt-get -qq update >/dev/null 2>&1 && apt-get -qq install -y git python3 >/dev/null 2>&1; git config --global user.email t@t; git config --global user.name t; npm i -g typescript@5.5.2 >/dev/null 2>&1; export CLAUDE_HARNESS_TS=/usr/local/lib/node_modules/typescript/lib/typescript.js; [ -f "$CLAUDE_HARNESS_TS" ] || { echo "нет typescript в контейнере: проверки содержимого дали бы unknown, а не fail"; exit 3; }; node --version; node --disable-warning=ExperimentalWarning --test --test-concurrency=2 "test/**/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail|duration)|^✖|AssertionError|actual:|expected:" '
