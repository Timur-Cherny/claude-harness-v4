// Слова-триггеры pre-bash. Источник истины для bin/prefilter.regex (шим не умеет TS):
// test/meta/prefilter.test.ts требует байтового равенства. Ложное срабатывание — один запуск Node;
// пропуск невозможен без обфускации, которую и токенизатор не разбирает.
export const PRE_BASH_TRIGGERS: readonly string[] = [
  'psql', 'pgcli', 'pg_dump', 'pg_restore', 'PGPASSWORD', 'postgres(ql)?://',
  'git( +-C +[^ ]+)? +(commit|push)', 'glab +mr',
  'jest', 'vitest', 'playwright', 'docker +(build|compose)', 'kind +(create|load)', 'run +build', 'tsc +-b',
  'corp-claude', 'codex +exec', 'kubectl +exec',
];
export const PRE_BASH_REGEX = new RegExp(PRE_BASH_TRIGGERS.join('|'));
export function prefilterSource(): string { return PRE_BASH_TRIGGERS.join('|'); }
