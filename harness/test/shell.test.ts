// INVARIANT: токенизатор тотален (никогда не бросает), кавычки не теряют содержимое, слова-триггеры
// видны в любом сегменте (kubectl exec … -- psql), а всё вне грамматики помечается unknown, не пропускается.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, commands, mentions, effective } from '../src/parsers/shell.ts';

describe('tokenize', () => {
  it('splits `cd X && git commit -m "a b"` into two commands and keeps the quoted message whole', () => {
    const p = tokenize('cd "$WMS_ENGINE" && git commit -m "fix: a b" -F msg.txt; echo done');
    assert.deepEqual(commands(p).map((c) => c.name), ['cd', 'git', 'echo']);
    assert.deepEqual(p.segments[1].argv, ['git', 'commit', '-m', 'fix: a b', '-F', 'msg.txt']);
  });
  it('sees psql as a token behind `kubectl exec pod --` and behind an env prefix', () => {
    assert.equal(mentions(tokenize("kubectl exec pod-x -- psql -c 'SET x = 1'"), 'psql'), true);
    assert.equal(mentions(tokenize('PGPASSWORD=x psql -h host -f q.sql'), 'psql'), true);
    assert.equal(effective(['PGPASSWORD=x', 'psql', '-h']).name, 'psql');
    assert.equal(effective(['env', '-u', 'CLAUDECODE', 'claude', '-p']).name, 'claude');
    assert.equal(effective(['sudo', 'timeout', '30', 'git', 'push']).name, 'git');
  });
  it('does not mistake `SET` inside a comment or a string for a command token', () => {
    const p = tokenize("echo 'psql is mentioned' # psql\nls");
    assert.deepEqual(commands(p).map((c) => c.name), ['echo', 'ls']);
    assert.equal(mentions(p, 'psql'), false);
  });
  it('descends one level into `sh -c "…"` and `eval`, and marks deeper nesting unknown instead of pretending to see it', () => {
    const one = tokenize('sh -c "psql -c 1"');
    assert.equal(mentions(one, 'psql'), true);
    assert.deepEqual(one.unknown, []);
    const two = tokenize(`sh -c 'bash -c "psql -c 1"'`);
    assert.ok(two.unknown.includes('nested-shell-depth'));
    const ev = tokenize('eval "git push origin main"');
    assert.equal(mentions(ev, 'push'), true);
  });
  it('marks command substitution and unterminated quotes as unknown', () => {
    assert.ok(tokenize('psql < $(cat x.sql)').unknown.includes('command-substitution'));
    assert.ok(tokenize("echo 'open").unknown.includes('unterminated-single-quote'));
  });

  describe('here-doc: тело разбирается, а не объявляется недоступным', () => {
    it('снимает тело с ограничителем и НЕ пускает его строки в поток команд', () => {
      const p = tokenize("cat <<'EOF'\nrm -rf /\nEOF\necho done");
      assert.deepEqual(p.segments.map((s) => s.argv), [['cat'], ['echo', 'done']], 'строка тела стала бы командой');
      assert.deepEqual(p.segments[0].heredocs, ['rm -rf /\n']);
      assert.deepEqual(p.unknown, [], 'ограничитель в кавычках: подстановок нет, знать нечего');
    });
    it('различает ограничитель в кавычках и голый: подстановка в теле оставляет unknown', () => {
      assert.deepEqual(tokenize("cat <<'EOF'\n$HOME\nEOF").unknown, []);
      assert.ok(tokenize('cat <<EOF\n$HOME\nEOF').unknown.includes('here-doc-expansion'));
      assert.ok(tokenize('cat <<EOF\nplain text\nEOF').unknown.length === 0, 'голый ограничитель без $ и бэктика — тело literal');
    });
    it('<<- срезает ведущие табы и у тела, и у ограничителя', () => {
      const p = tokenize('cat <<-EOF\n\tone\n\tEOF\necho after');
      assert.deepEqual(p.segments[0].heredocs, ['one\n']);
      assert.deepEqual(p.segments.map((s) => s.argv), [['cat'], ['echo', 'after']]);
    });
    it('два here-doc в одной команде читаются по порядку', () => {
      const p = tokenize("cmd <<'A' <<'B'\nfirst\nA\nsecond\nB");
      assert.deepEqual(p.segments[0].heredocs, ['first\n', 'second\n']);
    });
    it('ограничитель не встретился → here-doc-unterminated, не тишина', () => {
      assert.ok(tokenize('cat <<EOF\nno terminator').unknown.includes('here-doc-unterminated'));
      assert.ok(tokenize('cat <<EOF').unknown.includes('here-doc-unterminated'));
    });
    it('here-string <<< остаётся объявленной границей', () => {
      assert.ok(tokenize('psql <<< "select 1"').unknown.includes('here-string'));
    });
    it('скрипт, поданный ОБОЛОЧКЕ, разбирается на команды; тело psql — нет (это SQL, а не shell)', () => {
      assert.deepEqual(tokenize('bash <<EOF\nnpx jest\nEOF').segments.map((s) => s.argv), [['bash'], ['npx', 'jest']]);
      assert.deepEqual(tokenize('psql <<SQL\nSELECT 1; -- npm run build\nSQL').segments.map((s) => s.argv), [['psql']]);
    });
    it('причина живёт и в сегменте, и в общем списке: гейт смотрит в свой сегмент', () => {
      const p = tokenize('echo $(date)\ngit commit -F - <<EOF\nfix: $USER\nEOF');
      const commit = p.segments.find((s) => s.argv[1] === 'commit');
      assert.ok(commit?.unknown.includes('here-doc-expansion'));
      assert.ok(!commit?.unknown.includes('command-substitution'), 'чужая подстановка не приписывается этому сегменту');
    });
  });
  it('never throws on arbitrary input (seeded property, 2000 strings)', () => {
    let seed = 0x9e3779b9;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff; };
    const alphabet = ` \n;&|()'"\\$\`<>#=-abcXYZ09_/`;
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(rnd() * 40);
      let s = ''; for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      assert.doesNotThrow(() => tokenize(s), `seed-case ${n}: ${JSON.stringify(s)}`);
    }
  });
  it('treats `2>&1` as a redirection token, not as a background separator', () => {
    const p = tokenize('git push --help >/dev/null 2>&1; echo rc=$?');
    assert.deepEqual(commands(p).map((c) => c.name), ['git', 'echo']);
  });
});
