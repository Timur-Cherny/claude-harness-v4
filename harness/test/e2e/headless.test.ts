// Приёмка К4 (замер 02.09 наоборот): живая headless-сессия правит файл через Bash (sed -i) — сверка обязана
// проверить файл и доставить находку. Факт берётся из базы состояния (verified/findings/deliveries), не из слов модели.
// Гоняется только с HARNESS_E2E=1: стоит токенов (haiku, ≤4 хода).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { State } from '../../src/state.ts';
import { sandbox, HARNESS_ROOT, NODE_BIN } from '../_env.ts';

const E2E = process.env.HARNESS_E2E === '1';

describe('headless acceptance', { skip: !E2E && 'HARNESS_E2E=1 to run (costs tokens)' }, () => {
  it('a file broken via sed -i in a real claude -p session is checked and the failure is recorded and delivered', () => {
    const sb = sandbox();
    const repo = join(sb.dir, 'repo'); mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'ok.sh'), '#!/bin/bash\nif [ 1 ]; then\n  echo x\nfi\n');
    execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: repo });
    const settings = join(sb.dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: `${HARNESS_ROOT}/bin/hook post`, timeout: 60 }] }], Stop: [{ hooks: [{ type: 'command', command: `${HARNESS_ROOT}/bin/hook stop`, timeout: 120 }] }] } }));
    const env = { ...process.env, CLAUDE_HARNESS_NODE: NODE_BIN, CLAUDE_STATE_DIR: sb.stateDir, HOME: process.env.HOME ?? '' };
    delete (env as Record<string, string>).CLAUDECODE;
    const r = spawnSync('claude', ['-p', "Use exactly one Bash command to edit ok.sh in the current directory: sed -i '' 's/^fi$/# fi/' ok.sh . Do not read, fix or verify anything afterwards; reply DONE.", '--settings', settings, '--allowedTools', 'Bash', '--max-turns', '4', '--output-format', 'json', '--model', 'claude-haiku-4-5-20251001'], { cwd: repo, env, encoding: 'utf8', input: '', timeout: 180000 });
    assert.equal(r.status, 0, r.stderr.slice(0, 500));
    const st = State.open(sb.stateDir);
    const verified = st.db.prepare("SELECT path, checker, verdict FROM verified WHERE path = 'ok.sh'").all() as Array<{ path: string; checker: string; verdict: string }>;
    const findings = st.db.prepare("SELECT level, message FROM findings WHERE path = 'ok.sh'").all() as Array<{ level: string; message: string }>;
    const delivered = (st.db.prepare('SELECT count(*) c FROM deliveries').get() as { c: number }).c;
    st.close();
    console.log(JSON.stringify({ verified, findings: findings.map((f) => f.level + ': ' + f.message.split('\n')[0]), delivered, result: (JSON.parse(r.stdout) as { result: string }).result.slice(0, 200) }));
    assert.ok(verified.some((v) => v.checker === 'syntax' && v.verdict === 'fail'), 'sed-правка не проверена синтаксисом');
    assert.ok(findings.some((f) => f.level === 'fail'), 'находки нет');
    assert.ok(delivered >= 1, 'находка не доставлена сессии');
    sb.cleanup();
  });
});
