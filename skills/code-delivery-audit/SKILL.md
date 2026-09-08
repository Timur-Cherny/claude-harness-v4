---
name: code-delivery-audit
description: >-
  Adversarially audit a code change for silent event/message loss and
  delivery-correctness holes — dual-write hazards (DB commit + external
  publish/HTTP not atomic), fire-and-forget publishes, "fires only once"
  latches, at-most-once where at-least-once is required, missing idempotency
  on redelivery, and consumers that drop messages on error. Use this WHENEVER
  a diff touches: event emission or domain events, Kafka/RabbitMQ/SQS publish
  or consume, webhooks or HTTP status callbacks, a transactional outbox,
  after-commit hooks (runOnTransactionCommit / AFTER COMMIT), status or
  notification senders, ret/ack/nack/DLQ logic, or anywhere a database write
  must result in an external delivery. Also trigger when the user mentions
  lost events, duplicate events, "sent once", "only the first one arrives",
  dual write, exactly-once, at-least-once, outbox, idempotency, or a message
  that "didn't come through" — even if they don't name this skill. A green
  happy-path test does NOT prove delivery correctness; run this before
  approving such a change. The skill has two modes: auditing a diff, and
  triaging a loss that already happened when there is no diff to read — one
  named message followed hop by hop to the place it stopped being passed on.
---

# Message-delivery audit

## Why this exists

A real production incident motivated this skill: an order-status notifier was
changed so the status was delivered **once at order creation, and every later
order silently never appeared downstream**. The happy-path test passed. The
diff looked clean. The failure only shows up under crash-after-commit, broker
hiccup, redelivery, or a shared one-shot latch — none of which a green e2e
touches.

The unifying property of this bug class: **a durable state change and its
external delivery are not guaranteed to happen together, or the delivery
quietly runs for only some of the cases it must cover.** When that guarantee
breaks, the system keeps looking healthy while data stops flowing, and there
is often *no trace* of the loss. That silence is what makes these bugs
expensive.

Your job, in whichever of the two modes applies:

- **Mode A — audit a diff** (the usual entry): find every place a committed
  change must produce a delivery (or a delivery must reflect a committed
  change), construct the concrete scenario that breaks it, and report it with a
  minimal fix.
- **Mode B — triage a live loss**: a message already didn't come through and
  there is no diff to read. Follow one message to the hop that dropped it, then
  classify that hop with the same taxonomy.

Both modes are skeptical by default: assume "this can lose or duplicate a
message" until you can argue it can't.

## When this applies (the code shapes to scan for)

Look for any of these in the diff or its immediate neighbours:

- A DB write followed by (or preceded by) `publish` / `emit` / `producer.send`
  / an HTTP POST to another service / a webhook.
- After-commit or transaction-lifecycle hooks: `runOnTransactionCommit`,
  `AFTER COMMIT`, `afterCommit`, `@AfterTransactionCommit`, outbox relays.
- Detached execution around a delivery: `setImmediate`, `setTimeout`,
  `process.nextTick`, a floating promise, `void somePublish()`, `.then()` with
  no `.catch()`.
- Event listeners / one-shot handlers: `.once(`, `emitter.on(` combined with
  `removeAllListeners`, a boolean latch (`if (sent) return; sent = true`),
  a cached/memoized client or subscription created lazily on first use.
- Consumers: queue/topic subscribe handlers, `ack`/`nack`/`reject`,
  dead-letter config, retry counters (`x-death`, `retryMaxReached`, `maxTries`).
- Status/lifecycle senders where losing the message strands a workflow
  (order finished, payment captured, stock reserved, shipment created).

If none of these are present **and you are in Mode A**, this skill has nothing
to audit — say so and stop. In Mode B these shapes are what you are hunting
for: their absence from the recently changed files means the drop is somewhere
else, not that there is nothing to find.

## Mode A procedure — audit a diff

1. **Map the delivery paths.** For each change, write down the pairs:
   `(durable state change) → (external delivery)` and
   `(incoming delivery) → (durable effect)`. Name the transport (Rabbit/Kafka/
   HTTP/in-process event) and whether it is inside a DB transaction.

2. **Run the adversarial scenarios** against each path. For every one, ask
   "what is the observable end state, and is any trace left?":
   - **Rollback-after-publish** — publish happens, then the tx rolls back.
     Downstream now believes a state that never persisted.
   - **Crash/failure-after-commit** — tx commits, then the process dies or the
     broker is unreachable before/while publishing. Committed, never delivered,
     no retry.
   - **Redelivery** — the same message is delivered twice (at-least-once
     transports do this normally). Does the effect double, or is it idempotent?
   - **Second-and-subsequent** — the path runs for item #1, then #2, #3…
     Does the effect fire every time, or does shared/one-shot state gate it to
     the first? (This is the incident above — check it explicitly.)
   - **Two workers / concurrent** — two consumers or two requests hit the same
     resource. Ordering, double-processing, lost update.
   - **Poison message / handler throws** — the consumer errors. Requeue storm?
     Silently dropped? Blocks the partition/queue? Lands in a DLQ?

3. **Check the core invariants.** State them, then try to violate each:
   - *Atomicity*: every committed state change is delivered **at least once**,
     and every delivered message corresponds to a **committed** change.
   - *Completeness*: the delivery fires for **every** qualifying case, not just
     the first — no shared latch, no one-shot listener on a reused emitter.
   - *Idempotency*: redelivery causes the **same effect once** (dedup by a
     stable key the producer actually sends — order_id / reference_id / event id).
   - *Observability*: a lost or failed delivery leaves a **trace** — a persisted
     row, an error log, a metric, or a DLQ entry. If the change removes the only
     trace, that itself is a finding.

4. **Judge required delivery semantics.** Ask: *if this one delivery is lost,
   does the system self-heal (a reconcile job, a poll, a later event re-derives
   it)?* If yes, best-effort may be fine — say so. If no (a lifecycle/money/
   inventory transition that nothing else will re-emit), it needs **at-least-once
   + idempotent consume**, which in practice means a real transactional outbox
   or equivalent — not a fire-and-forget publish.

## Mode B procedure — triage a live loss

**Do not open with counters at the two ends.** In this bug class they agree. A
consumer that catches the error, logs it and still `ack`s — or returns early on
a guard — increments "received" and "acked" exactly like a healthy one. Equal
totals are the *expected* reading of a silent drop, not evidence against one.

Open at the other end: **follow ONE message to the hop where it stopped being
passed on.**

1. **Take a single named instance** — this order id, this reference id, this
   timestamp. One real message beats any aggregate, because an aggregate cannot
   tell you *where* it stopped.
2. **Walk the hops in order**, asking only two questions at each — did it
   arrive, and did it leave?
   `producer call site → broker (exchange/topic, routing key, partition, DLQ) →
   consumer entry → the handler's own branches → the durable effect`.
3. **The first hop where "arrived" is true and "left" is false is the answer.**
   It is usually inside the handler, not on the wire:
   - an early `return`/guard before the effect;
   - a swallowed `catch` followed by `ack` (taxonomy 6);
   - a filter that silently doesn't match — routing key, partition key,
     company/tenant scope, or a status value the code no longer expects;
   - **a handler that intercepted the event and never delegated onward** — an
     override that never calls the base / `super` / `next` implementation.
     Everything upstream of it measures healthy, because it *is* healthy: the
     message arrived, was accepted, and was consumed by design. Only the
     onward call is missing, and nothing counts a call that was never made.
4. **Only now bring in counters**, as a bisection over hops you have already
   walked — not as the opening question.
5. If the message did leave the last hop and the effect still isn't there, the
   loss is downstream: repeat from step 1 in the next service. Don't conclude
   from the edge of your own service.

Then classify the hop with the taxonomy below — it is the lookup table, and the
class names the fix — and report in the same output format.

## Failure taxonomy (what to look for, why it bites, the fix)

**1. Dual-write (DB + external not atomic).** Two independent writes that must
both happen. *Both* directions fail:
- publish-before-commit → emits for transactions that then roll back (phantom
  downstream state);
- commit-then-publish → commits, then the publish is lost to a crash/broker
  outage with no retry (silent hole).
Tell: a `publish`/HTTP call in the same method as a repository `save`, with no
outbox row written in the same transaction. Fix: **transactional outbox** —
persist the message in the same DB tx (pending), a relay publishes it with
retries and marks it sent, consumer is idempotent. After-commit hooks alone are
*not* an outbox: they close the rollback direction but leave the lost-after-
commit direction open, so call that out explicitly (at-most-once).

**2. Fire-and-forget delivery.** The publish is not awaited, runs in
`setImmediate`/`setTimeout`/a floating promise, or has no `.catch()`, no
publisher-confirms, no ack check. Tell: `setImmediate(() => conn.publish(...))`,
`void publish()`, `.publish(...)` whose result is discarded. Bites: any transient
broker error vanishes as an unhandled rejection; the message is gone and nothing
records it. Fix: await it, check publisher-confirm/ack, and on failure persist/
retry (or at minimum log+metric so the loss is visible).

**3. Fires-once / shared one-shot state.** An effect that must run per item/
event is gated by state that is set once. Tell: `.once('commit', …)` on an
emitter that is reused across items; `removeAllListeners()` on a shared emitter;
a module-level or singleton `sent`/`initialized` flag; a subscription or client
created lazily on first message and cached; an AsyncLocalStorage/hook context
that isn't recreated per unit of work. Bites: item #1 works, #2…N silently
no-op — exactly the production incident. Fix: scope the latch/emitter/context to
the unit of work (per event, per request, per message), and add a test that
drives **two** items through the path, asserting the effect fires twice.

**4. At-most-once where at-least-once is required.** A must-arrive transition
(order finished, payment, stock, shipment) delivered best-effort. Tell: a single
unretried publish/HTTP for a terminal or money/inventory state. Fix: durable
delivery + idempotency, or a reconcile/poll fallback that re-derives the state.

**5. Missing idempotency on redelivery.** At-least-once transports redeliver; a
non-idempotent consumer double-applies. Tell: consumer does `INSERT`/increment/
side effect keyed on nothing stable, or the producer sends no idempotency key.
Fix: dedup on a natural/stable key (the producer already has order_id/
reference_id — use it); make the write upsert/`ON CONFLICT DO NOTHING`.

**6. Consumer error handling.** Handler throws → what happens? Tell: no
try/catch around effectful consume, no nack/requeue policy, no DLQ, no retry cap.
Bites: silent drop, or infinite requeue storm, or a poison message blocking the
queue. Fix: explicit ack-on-success, bounded retry → DLQ, and log the failure.

**7. Ordering / concurrency.** Logic assumes in-order delivery or a single
consumer. Tell: partition/queue with >1 consumer and order-dependent effects, or
a read-modify-write without a lock/version. Fix: partition by entity key, or make
the effect order-independent / use optimistic concurrency.

**8. Transaction-boundary side effects.** External I/O (publish, HTTP) inside a
`@Transactional` method that will not roll back the I/O. Tell: a webhook/publish
in a method wrapped by a transaction. Fix: move the delivery to after-commit
(and then apply outbox thinking for the lost-after-commit direction).

## Output format

Report only real, argued findings — no checklist theatre. For each:

```
### [SEVERITY] <short title>
**Path:** <state change> → <delivery>  (transport, in-tx?)
**Failing scenario:** <2–4 step concrete trace that loses/dupes/skips a message>
**Tell:** <file:line or the code smell>
**Fix:** <minimal change to close it> — and, if relevant, the proper fix.
```

Severity: **blocker** = can silently lose or phantom a must-arrive message in
normal operation (crash/redelivery/second-item are normal); **high** = loss/dup
under plausible failure; **medium** = correct today but fragile / no trace of
failure. End with a one-line verdict: does this change preserve at-least-once +
idempotent + fires-every-time, or not? If you genuinely cannot construct a
failing scenario, say "no delivery hole found" and explain why the guarantee
holds — don't invent findings.

## Worked example (the incident)

Diff: `publish()` changed from an immediate `amqpConnection.publish(...)` to
`runOnTransactionCommit(broadcast)` (fall back to immediate when no tx), where
`broadcast` publishes to Rabbit and an `@RabbitSubscribe` job then sends the
order status onward.

Audit output (abridged):
- **[high] Lost-after-commit dual-write.** finished-status → Rabbit publish,
  after-commit. Scenario: tx commits (order = finished in DB) → pod restarts /
  Rabbit briefly down before the `setImmediate` broadcast fires → status never
  published, no retry, no persisted trace. Downstream never learns the order
  finished. Tell: message not persisted; broadcast in detached `setImmediate`
  with no `.catch()`/confirm. Fix: transactional outbox (row in same tx + relay
  + idempotent consume); minimum stopgap: `broadcast().catch(logAndMetric)` +
  publisher confirms so the loss is at least visible.
- **[medium] Failure is invisible.** A dropped broadcast leaves no row/log/DLQ,
  so "status generated but never delivered" is unobservable in this service.
- **Fires-once check:** verify the hook emitter/context is per-transaction, not a
  reused singleton — a shared `once('commit')` + `removeAllListeners()` would
  deliver item #1 and silently skip the rest (the reported prod symptom). Add a
  two-order test through the path.

Verdict: change fixes the rollback direction only; at-most-once remains → not
safe for must-arrive order statuses without an outbox or reconcile fallback.
