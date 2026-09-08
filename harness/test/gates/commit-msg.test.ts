// Молча ломалось: bash-оригинал grep'ал текст команды — сообщение из файла (`-F msg.txt`) не читалось
// (дыра названа в его шапке L9-10), а `git commit` внутри `cd X &&` зависел от regex по всей строке.
// INVARIANT: атрибуция в сообщении коммита → deny из любого источника, который гейт может прочитать
// (-m, -F <file>, тело here-doc); источник, который прочитать нельзя (stdin из трубы, `<<EOF` с
// подстановкой, незакрытый ограничитель, $(…)) → unknown, не silent, кроме случая, когда атрибуция
// видна в сыром тексте команды — тогда deny, как у bash-оригинала.
// REGRESSION: `git commit -F msg.txt` с Co-Authored-By: Claude проходил.
// REGRESSION: `git commit -F - <<EOF` отвечал unknown → ask на КАЖДЫЙ коммит, хотя тело лежит в той же
// строке команды. Из-за такого же ask на `psql <<SQL` pg-барьер выключили целиком (harness.env 08.09).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/gates/commit-msg.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox();
after(() => sb.cleanup());

function run(command: string, env: NodeJS.ProcessEnv = {}, cwd = sb.dir): Verdict {
  const payload = bashPayload(command) as unknown as HookPayload;
  (payload as { cwd: string }).cwd = cwd;
  const ctx: GateContext = { event: 'pre-bash', payload, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
  return decide(ctx);
}

describe(NAME, () => {
  describe('denies attribution given through -m (bash corpus)', () => {
    for (const [what, cmd] of [
      ['Co-Authored-By: Claude', "git commit -m 'fix: x Co-Authored-By: Claude'"],
      ['noreply@anthropic.com', "git commit -m 'fix: noreply@anthropic.com'"],
      ['Generated with Claude', "git commit -m 'Generated with Claude'"],
      ['Claude-Session', "git commit -m 'fix Claude-Session: a'"],
      ['robot emoji', "git commit -m 'fix 🤖'"],
    ] as const) {
      it(`denies ${what}`, () => {
        const v = run(cmd);
        assert.equal(v.kind, 'deny', JSON.stringify(v));
        assert.match((v as { reason: string }).reason, /AI-атрибуция/);
      });
    }
    it('denies Co-Authored-By: Anthropic in the second -m paragraph', () => {
      assert.equal(run('git commit -m "fix: x" -m "Co-Authored-By: Anthropic <x@y>"').kind, 'deny');
    });
    it('denies the message glued to the flag (-am, -m"…") — the tokenizer collapses the quote', () => {
      assert.equal(run('git commit -am "fix 🤖"').kind, 'deny');
      assert.equal(run('git commit -m"Generated with Claude Code"').kind, 'deny');
      assert.equal(run('git commit --message="fix Claude-Session: 1"').kind, 'deny');
    });
    it('denies a commit reached through `cd X &&` and through `git -C X` — argv, not a regex over the line', () => {
      assert.equal(run(`cd ${sb.dir} && git commit -m 'Co-Authored-By: Claude'`).kind, 'deny');
      assert.equal(run(`git -C ${sb.dir} -c user.name=t commit -m 'noreply@anthropic.com'`).kind, 'deny');
      assert.equal(run(`git status && sh -c "git commit -m 'fix 🤖'"`).kind, 'deny');
    });
  });

  describe('stays silent on a clean message — for different reasons', () => {
    it('plain text', () => { assert.equal(run("git commit -m 'fix: обычный текст'").kind, 'silent'); });
    it('the word claude used on topic', () => { assert.equal(run("git commit -m 'docs: описал контур claude-хуков'").kind, 'silent'); });
    it('a non-commit git command', () => { assert.equal(run('git status --porcelain').kind, 'silent'); });
    it('attribution in an echo, not in the commit message', () => {
      assert.equal(run("echo 'Co-Authored-By: Claude' > notes.txt && git commit -m 'fix: x'").kind, 'silent');
    });
    it("a commit without a message in the command (--amend --no-edit) — the message is not the command's data", () => {
      assert.equal(run('git commit --amend --no-edit').kind, 'silent');
    });
    it('a non-Bash tool and an empty command', () => {
      const payload = { ...bashPayload(''), tool_name: 'Write', tool_input: { file_path: '/x' } } as unknown as HookPayload;
      assert.equal(decide({ event: 'pre-bash', payload, env: {}, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now }).kind, 'silent');
      assert.equal(run('   ').kind, 'silent');
    });
  });

  describe('reads the message file (new: the -F hole of the bash original)', () => {
    it('denies `git commit -F msg.txt` whose file carries Co-Authored-By: Claude', () => {
      writeFileSync(join(sb.dir, 'msg.txt'), 'fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
      const v = run('git commit -F msg.txt');
      assert.equal(v.kind, 'deny', JSON.stringify(v));
    });
    it('denies the same file through --file=, -F<glued> and a relative path after cd', () => {
      writeFileSync(join(sb.dir, 'm2.txt'), 'Generated with Claude\n');
      assert.equal(run('git commit --file=m2.txt').kind, 'deny');
      assert.equal(run('git commit -Fm2.txt').kind, 'deny');
      assert.equal(run(`cd ${sb.dir} && git commit -F ./m2.txt`, {}, '/').kind, 'deny');
    });
    it('passes a clean message file', () => {
      writeFileSync(join(sb.dir, 'clean.txt'), 'fix(orders): обычный текст\n');
      assert.equal(run('git commit -F clean.txt').kind, 'silent');
    });
    it('answers unknown when the file does not exist yet — it cannot be read, so it cannot be cleared', () => {
      const v = run('git commit -F missing.txt');
      assert.equal(v.kind, 'unknown');
      assert.match((v as { reason: string }).reason, /missing\.txt/);
    });
  });

  describe('the here-doc body is a readable source, not an opaque one', () => {
    it('reads a clean message out of -F - <<EOF and stays silent — an ordinary commit asks nothing', () => {
      const v = run("git commit -q -F - <<'EOF'\nfix(returns): reject a type (NO-JS)\n\nSecond paragraph.\nEOF");
      assert.deepEqual(v, { kind: 'silent' }, JSON.stringify(v));
    });
    it('denies attribution inside the here-doc body: the source is readable, so the verdict is proof', () => {
      assert.equal(run("git commit -F - <<'EOF'\nfix: x\n\nCo-Authored-By: Claude\nEOF").kind, 'deny');
    });
    it('keeps the body out of the command stream: a message quoting a command is not a second command', () => {
      const v = run("echo start\npython3 - <<'PY'\ns = \"git commit -m Generated with Claude\"\nPY\necho done");
      assert.deepEqual(v, { kind: 'silent' }, 'тело чужого here-doc не команда: фантомного git commit нет');
    });
    it('reads a tab-stripped <<- body', () => {
      const v = run("git commit -F - <<-'EOF'\n\tfix: indented body\n\tEOF");
      assert.deepEqual(v, { kind: 'silent' }, JSON.stringify(v));
    });
  });

  describe('sources it cannot read give unknown, never silent', () => {
    it('stdin fed by a pipe, not by a here-doc → unknown', () => {
      const v = run('printf x | git commit -F -');
      assert.equal(v.kind, 'unknown', JSON.stringify(v));
      assert.match((v as { reason: string }).reason, /stdin/);
    });
    it('unquoted <<EOF with a substitution in the body → unknown: the final text is not known', () => {
      const v = run('git commit -F - <<EOF\nfix: $(date)\nEOF');
      assert.equal(v.kind, 'unknown', JSON.stringify(v));
      assert.match((v as { reason: string }).reason, /here-doc-expansion/);
    });
    it('a here-doc without its terminator → unknown, never silent', () => {
      const v = run('git commit -F - <<EOF\nfix: no terminator follows');
      assert.equal(v.kind, 'unknown', JSON.stringify(v));
      assert.match((v as { reason: string }).reason, /here-doc-unterminated/);
    });
    it('message from command substitution → unknown', () => {
      assert.equal(run('git commit -m "$(cat msg.txt)"').kind, 'unknown');
    });
    it('cd into an unset variable makes the file path unresolvable → unknown', () => {
      const v = run('cd "$NOT_SET_DIR_X" && git commit -F msg.txt', {});
      assert.equal(v.kind, 'unknown');
    });
  });

  describe('through the router', () => {
    const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
    it('kill-switch CLAUDE_SKIP_COMMIT_GUARD=1 → silent and nothing written to state or journals', async () => {
      const payload = bashPayload("git commit -m 'Co-Authored-By: Claude'") as unknown as HookPayload;
      const v = await route('pre-bash', payload, { ...env, CLAUDE_SKIP_COMMIT_GUARD: '1' });
      assert.equal(v.kind, 'silent');
      assert.deepEqual(readdirSync(sb.stateDir), []);
      assert.deepEqual(readdirSync(sb.home), []);
    });
    it('without the switch the same payload is denied with the gate name', async () => {
      const payload = bashPayload("git commit -m 'Co-Authored-By: Claude'") as unknown as HookPayload;
      const v = await route('pre-bash', payload, env);
      assert.equal(v.kind, 'deny');
      assert.equal((v as { gate: string }).gate, NAME);
    });
  });
});
