// Порт hooks/message-delivery-tripwire.sh: правка, ДОБАВЛЯЮЩАЯ код доставки (publish/emit/after-commit/
// one-shot/consumer/ack-dlq/outbox/webhook), требует прогона code-delivery-audit — зелёный happy-path этого класса не ловит.
// INVARIANT: сигнал только из добавленных строк и только из структуры (вызовы, декораторы, идентификаторы,
// строковые литералы) — комментарий со словом outbox доставкой не является.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../_env.ts';
import { initRepo, changed, ctx } from './_repo.ts';
import { checker } from '../../src/checks/tripwire.ts';
import { CHECKERS } from '../../src/checks/registry.ts';

const BASE = 'export async function handle(bus: any, order: any): Promise<void> {\n  await bus.save(order);\n}\n';

async function runWith(sb: ReturnType<typeof sandbox>, name: string, added: string, ext = 'ts') {
  const repo = initRepo(sb, name);
  repo.write(`h.${ext}`, BASE); repo.commitAll();
  repo.write(`h.${ext}`, BASE.replace('  await bus.save(order);', `  await bus.save(order);\n${added}`));
  return checker.run(changed(repo, `h.${ext}`), ctx(sb));
}

describe('message-delivery tripwire checker', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('registers as sync with the bash kill-switch and applies to the TS/JS family only', () => {
    assert.ok(CHECKERS.some((c) => c.name === 'tripwire'));
    assert.equal(checker.tier, 'sync');
    assert.equal(checker.killSwitch, 'CLAUDE_SKIP_DELIVERY_TRIPWIRE');
    const f = { repo: '/r', path: 'a.ts', absPath: '/r/a.ts', digest: '0', status: 'M' } as const;
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) assert.equal(checker.applies({ ...f, path: p, absPath: `/r/${p}` }), true, p);
    for (const p of ['a.go', 'a.py', 'a.md', 'a.sql']) assert.equal(checker.applies({ ...f, path: p, absPath: `/r/${p}` }), false, p);
  });

  const cases: Array<[string, string, RegExp]> = [
    ['.publish(', '  await bus.publish(order);', /publish/],
    ['producer.send(', '  await this.producer.send({ topic: "t", messages: [] });', /publish/],
    ['kafka client .send(', '  await kafkaClient.send(order);', /publish/],
    ['.sendMessage(', '  await sqs.sendMessage(order);', /publish/],
    ['amqp import', '  const ch = await amqp.connect(url);', /publish/],
    ['runOnTransactionCommit(', '  runOnTransactionCommit(() => bus.notify(order));', /after-commit-hook/],
    ['afterCommit(', '  tx.afterCommit(() => bus.notify(order));', /after-commit-hook/],
    ['setImmediate(', '  setImmediate(() => bus.notify(order));', /detached-side-effect/],
    ['process.nextTick(', '  process.nextTick(() => bus.notify(order));', /detached-side-effect/],
    ['.once(', '  bus.once("done", () => order.close());', /once-listener/],
    ['@RabbitSubscribe decorator', '  class C { @RabbitSubscribe({ queue: "q" }) on(): void {} }', /consumer/],
    ['@EventPattern decorator', '  class D { @EventPattern("x") on(): void {} }', /consumer/],
    ['nack(', '  channel.nack(msg, false, false);', /ack\/dlq/],
    ['dead-letter identifier', '  const deadLetterQueue = order.dlq;', /ack\/dlq/],
    ['requeue identifier', '  const requeueLater = true;', /ack\/dlq/],
    ['outbox identifier', '  await outboxRepo.insert(order);', /outbox/],
    ['webhook string literal', '  await fetch("https://x/webhook", { method: "POST" });', /webhook/],
    ['.emit( without category', '  bus.emit("saved", order);', /delivery-code/],
  ];
  for (const [title, added, cat] of cases) {
    it(`fails and names the category for added ${title}`, async () => {
      const r = await runWith(sb, `r-${cases.findIndex((c) => c[0] === title)}`, added);
      assert.equal(r.verdict, 'fail', r.message ?? r.missing_reason);
      assert.match(r.message ?? '', cat);
      assert.match(r.message ?? '', /code-delivery-audit/);
      assert.match(r.message ?? '', /L3\b/);
    });
  }

  it('passes plain persistence code — no delivery pattern, no nudge', async () => {
    const r = await runWith(sb, 'r-plain', '  await bus.repo.update(order.id, { status: "saved" });');
    assert.equal(r.verdict, 'pass', r.message);
  });

  it('passes when the delivery call is an old line and only unrelated code was added', async () => {
    const repo = initRepo(sb, 'r-old');
    const base = BASE.replace('  await bus.save(order);', '  await bus.save(order);\n  await bus.publish(order);');
    repo.write('h.ts', base); repo.commitAll();
    repo.write('h.ts', base.replace('  await bus.save(order);', '  order.touched = true;\n  await bus.save(order);'));
    assert.equal((await checker.run(changed(repo, 'h.ts'), ctx(sb))).verdict, 'pass');
  });

  it('passes a comment that merely mentions outbox and publish — words in comments deliver nothing', async () => {
    const r = await runWith(sb, 'r-comment', '  // outbox: publish happens elsewhere, see webhook docs');
    assert.equal(r.verdict, 'pass', r.message);
  });

  it('works on a .js file through the same TypeScript parser', async () => {
    const repo = initRepo(sb, 'r-js');
    repo.write('h.js', 'export async function handle(bus, order) {\n  await bus.save(order);\n}\n'); repo.commitAll();
    repo.write('h.js', 'export async function handle(bus, order) {\n  await bus.save(order);\n  await bus.publish(order);\n}\n');
    const r = await checker.run(changed(repo, 'h.js'), ctx(sb));
    assert.equal(r.verdict, 'fail');
  });

  it('answers unknown without typescript — the nudge is not silently skipped', async () => {
    const repo = initRepo(sb, 'r-nots');
    repo.write('h.ts', BASE); repo.commitAll();
    repo.write('h.ts', BASE.replace('  await bus.save(order);', '  await bus.save(order);\n  await bus.publish(order);'));
    const r = await checker.run(changed(repo, 'h.ts'), ctx(sb, {}));
    assert.equal(r.verdict, 'unknown');
    assert.match(r.missing_reason ?? '', /typescript/i);
  });
});
