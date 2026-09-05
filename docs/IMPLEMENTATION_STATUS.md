# Implementation status

## M0 — Repo foundation

- Status: complete
- Stack: NestJS application shells, Drizzle ORM with PostgreSQL, pnpm workspaces.
- Domain seam: framework- and vendor-independent.
- ADRs: ADR-001, ADR-002, ADR-003 accepted.
- Acceptance: `pnpm check` passed; lint, format, strict typecheck, and 8 unit tests are green.

## M1 — Local platform and schema

- Status: complete pending acceptance evidence
- Runtime: Docker Compose committed; native PostgreSQL/Redis accepted for this host because Docker is unavailable.
- Persistence: checked-in SQL migrations, tenant-scoped repositories, transaction helper, deterministic synthetic seeds.
- Health: liveness and dependency-aware readiness endpoints implemented.
- Acceptance: migration-from-zero, tenant isolation, transaction rollback, reset guard, invariant, seed, and live health checks passed.

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

The database acceptance commands used `TEST_DATABASE_URL=postgresql://app@127.0.0.1:55432/handoff_control_tower_test`. No real customer, vendor, payment, or accounting data is used.

### Migration list

1. `0001_tenants_connections.sql` — tenants, connection registry, ownership enums.
2. `0002_inbox_outbox.sql` — durable inbox/outbox records, uniqueness, claim indexes.
3. `0003_orders_fulfillment.sql` — canonical orders, lines, fulfillment actuals.
4. `0004_shipments_process.sql` — shipments, shipment lines, process instances.
5. `0005_exceptions_reconciliation.sql` — exception queue and reconciliation records.
6. `0006_audit_indexes.sql` — append-only audit events and indexes.

## Known environment risks

- This workspace has no `.git` directory, so Git history/status cannot be verified or repaired by the implementation.
- Docker is not installed on the development host; Compose has not been executed locally unless a Docker-compatible runtime is provided.
- Native PostgreSQL and Redis services must be started before database and readiness acceptance checks; the verified services were isolated temporary processes and are not part of the repository.
