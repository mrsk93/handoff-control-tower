# ADR-002: Transactional inbox/outbox with at-least-once delivery

## Status

Accepted for M0/M1 and all later milestones.

## Decision

Inbound messages are persisted before processing. A single PostgreSQL transaction claims or records the inbound message, applies domain state changes, creates exceptions and audit events, and inserts required outbound messages. The transaction commits before any remote I/O occurs.

An outbox dispatcher runs after commit and uses leased claims, retry classification, bounded backoff, dead-letter status, and stable idempotency keys. Delivery is at least once. Remote effects must be idempotent or protected by read-before-create/reference lookup in the adapter. The system never claims exactly-once transport.

## Consequences

- A worker crash after commit leaves durable work for the dispatcher.
- A worker crash during remote I/O can cause a repeat attempt, so adapters must make effects idempotent.
- Inbox and outbox uniqueness constraints make duplicate messages visible and safe.
- No database transaction is held while waiting on a remote system.

## Non-goals

This pattern does not create a distributed transaction, guarantee remote exactly-once behavior, or create accounting invoices. Billing receives only guarded eligibility events.
