# Handoff Control Tower recovery runbook

This runbook covers the synthetic local/demo runtime. It is an operational aid for recovery, not
a claim of regulatory compliance. External systems remain behind versioned adapters; the checked-in
adapters are deterministic mocks and are never vendor implementations.

## First response

1. Capture the `tenantId`, `correlationId`, `messageId`, `idempotencyKey`, `orderId`, `outboxId`,
   `exceptionId`, and `reconciliationRunId` from structured logs or the operator read model.
2. Check `GET /health/live` for application liveness and `GET /health/ready` for PostgreSQL and
   Redis dependency status. A live but unready process must not acknowledge new work as healthy.
3. Inspect the inbox, exception, outbox, and reconciliation views for the same correlation ID.
4. Do not copy request payloads, credentials, payment data, or raw remote responses into logs or
   tickets. Use allowlisted reason codes and evidence references.

## Durable message failures

- A message is persisted in the inbox before processing. Repeated delivery is expected and safe
  only when the idempotency key and resulting effect remain stable.
- A transient process or adapter failure should remain retryable with bounded attempts and backoff.
- A dead-lettered outbox message requires a named operator command and a reason. Verify the linked
  exception, dependency health, and remote read-before-create/idempotency behavior before retrying.
- Remote I/O must happen after the database claim transaction commits. Never hold a PostgreSQL
  transaction open while waiting on an adapter.
- A remote effect may exist even when the worker crashed before recording `sent`. Re-dispatch with
  the same idempotency key and inspect the synthetic remote receipt; do not create a new key.

## Reconciliation drift

Run a bounded reconciliation window after dependencies recover. Review the finding category and
source evidence before applying a repair. Quantity, identity, and tracking disagreements remain
manual; values are never silently merged. Reconciliation is repeatable through persisted leases,
page cursors, and overlapping watermarks.

## Operator access

The local console uses explicitly synthetic headers. Viewer principals may read; operator
principals may issue named commands; admin principals may operate the development simulator. The
synthetic authentication seam rejects these headers in production until an external authentication
adapter is provided. Rate limits are enforced per tenant and operator, with Redis as the runtime
store and an in-memory store only for direct deterministic tests.

## Reset and data safety

`pnpm db:reset` refuses databases outside an explicit `handoff_control_tower_demo*` or
`handoff_control_tower_test*` name and refuses production. Stop and request review if a destructive
operation would touch any other database. All repository data and fixtures are synthetic.

## Billing boundary

The system emits guarded invoice-eligibility events only. It never creates accounting invoices.
If a recovery action appears to require an invoice mutation, stop and escalate it as a scope error.
