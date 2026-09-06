# Implementation status

## M0 — Repo foundation

- Status: complete
- Stack: NestJS application shells, Drizzle ORM with PostgreSQL, pnpm workspaces.
- Domain seam: framework- and vendor-independent.
- ADRs: ADR-001, ADR-002, ADR-003 accepted.
- Acceptance: `pnpm check` passed; lint, format, strict typecheck, and 8 unit tests are green.

## M1 — Local platform and schema

- Status: complete
- Runtime: Docker Compose committed; native PostgreSQL/Redis accepted for this host because Docker is unavailable.
- Persistence: checked-in SQL migrations, tenant-scoped repositories, transaction helper, deterministic synthetic seeds.
- Health: liveness and dependency-aware readiness endpoints implemented.
- Acceptance: migration-from-zero, tenant isolation, transaction rollback, reset guard, invariant, seed, and live health checks passed.

## M2 — Domain models and policies

- Status: complete
- Canonical domain types and runtime schemas cover orders, fulfillment actuals, shipments, quantities, exceptions, and invoice eligibility inputs.
- Quantity value objects and invariant checks reject negative, regressive, over-allocated, over-packed, and over-shipped state.
- Immutable order-release and fulfillment state machines emit deterministic domain events, require reasons for manual/exception decisions, and expose duplicate-command handling through stable idempotency keys.
- Invoice eligibility is a pure policy decision with a 27-case truth table. It emits a guarded eligibility decision/event only; it never creates accounting invoices.
- Domain source remains framework-, ORM-, transport-, cache-, and vendor-independent; source-specific terminology is kept outside the domain seam.
- Acceptance: `pnpm check` passed with 41 unit tests, including 27 policy combinations and the architecture dependency check.

## M3 — Inbox ingestion and idempotency

- Status: complete
- Ingress: source-specific HMAC-SHA256 verification over the exact raw body, bounded JSON payloads, trusted mock tenant context, and normalized integration envelopes.
- Inbox: conflict-safe tenant-scoped persistence, stable message/idempotency uniqueness, source-version stale classification, prerequisite parking, claim leases, attempt counts, outcome recording, and retry/dead-letter fields.
- Delivery semantics: at-least-once claim/outcome flow; duplicate effects are prevented by inbox uniqueness. No exactly-once transport claim is made, and no remote I/O occurs inside the inbox persistence transaction.
- Truthful boundary: endpoints and source labels are explicitly synthetic mocks. No proprietary WMS API or real vendor connector is implemented; no accounting invoice is created.
- Acceptance: 9 PostgreSQL integration tests passed, including concurrent duplicate contention, invalid signature/payload no-mutation checks, visible out-of-order parking, claim completion, and stale-version handling. Unit suite passed with 44 tests.

## M4 — Transactional outbox and dispatcher

- Status: complete
- Transaction seam: domain state changes and outbound messages are written through one tenant-scoped PostgreSQL transaction. Duplicate appends return the existing durable row by destination and idempotency key; failures roll back both state and outbound work.
- Dispatcher: multiple workers claim pending/retryable rows with `FOR UPDATE SKIP LOCKED`, use leases, reclaim expired dispatches, and update delivery state only with the owning lease. Remote adapter calls happen after claim commit and before the short result-update transaction; no database transaction spans remote I/O.
- Delivery semantics: at-least-once delivery with stable idempotency keys. Retry uses bounded exponential backoff and deterministic jitter inputs; exhausted attempts become dead letters and manual retry requires an operator reason. Exactly-once transport is not claimed.
- External boundary: `DeterministicMockOutboundAdapter` is an explicit synthetic adapter that deduplicates effects by tenant, destination, and idempotency key. It is not a real commerce, WMS, carrier, or billing vendor connector.
- Acceptance: transactional commit/rollback, duplicate appends, multi-worker claims, expired lease recovery, successful dispatch, transient retry, crash-after-effect replay, duplicate remote-effect suppression, dead-lettering, and guarded manual retry are covered by 8 PostgreSQL integration tests plus retry-policy unit coverage.

## Acceptance evidence

### Verified environment

- Node `v22.21.1`
- pnpm `10.33.0`
- PostgreSQL `18`, isolated temporary cluster on port `55432`
- Redis `8.4.0`, isolated process on port `56379`
- Docker unavailable on the host; `docker compose` was not executed

### Verified commands

- `pnpm install --frozen-lockfile`
- `pnpm check`
- `pnpm db:migrate`
- `pnpm db:seed`
- `pnpm test:integration` — 4 tests passed
- `pnpm test:tenant-isolation` — 3 tests passed
- `pnpm test:migration-from-zero` — 1 test passed
- `pnpm test:reset-guard` — 2 tests passed
- `pnpm test:health` — 2 tests passed
- `pnpm db:reset` — guarded reset and migration succeeded on the named test database
- `pnpm tsx scripts/verify-invariants.ts` — quantity invariants valid
- `GET /health/live` — `{"status":"ok"}`
- `GET /health/ready` — PostgreSQL and Redis reported `ok`
- `pnpm check` after M2 changes — lint, format, strict typecheck, and 41 unit tests passed
- `pnpm test:inbox-ingestion` — 5 PostgreSQL integration tests passed
- `pnpm test:integration` after M3 changes — 9 PostgreSQL integration tests passed
- signed HTTP smoke check — `/health/live` returned `200`, `/health/ready` reported PostgreSQL/Redis `ok`, and a synthetic signed commerce event returned `202` with a durable inbox ID
- `pnpm test:outbox-dispatcher` — 8 PostgreSQL integration tests passed
- `pnpm test:integration` after M4 changes — 17 PostgreSQL integration tests passed
- `pnpm check` after M4 changes — lint, format, strict typecheck, and 45 unit tests passed
- `pnpm db:migrate` — checked-in migrations completed with no pending changes
- `pnpm db:seed` — deterministic two-tenant synthetic seed completed

The database acceptance commands used `TEST_DATABASE_URL=postgresql://app@127.0.0.1:55432/handoff_control_tower_test`. No real customer, vendor, payment, or accounting data is used.

### Migration list

1. `0001_tenants_connections.sql` — tenants, connection registry, ownership enums.
2. `0002_inbox_outbox.sql` — durable inbox/outbox records, uniqueness, claim indexes.
3. `0003_orders_fulfillment.sql` — canonical orders, lines, fulfillment actuals.
4. `0004_shipments_process.sql` — shipments, shipment lines, process instances.
5. `0005_exceptions_reconciliation.sql` — exception queue and reconciliation records.
6. `0006_audit_indexes.sql` — append-only audit events and indexes.

## Known environment risks

- Docker is not installed on the development host; Compose has not been executed locally unless a Docker-compatible runtime is provided.
- Native PostgreSQL and Redis services must be started before database and readiness acceptance checks; the verified services were isolated temporary processes and are not part of the repository.
- M4 currently stops at transactional outbox and generic synthetic delivery. Domain event processing, vendor-specific mock contracts, fulfillment orchestration, reconciliation, operator commands/UI, and billing-event integration remain intentionally deferred to later milestones.
