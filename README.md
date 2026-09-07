# Handoff Control Tower

This repository is a production-style portfolio demonstration of the commerce → warehouse → carrier → billing handoff. Vendor integrations are deterministic mocks, and all data is synthetic. The system emits guarded invoice-eligibility events; it does not create accounting invoices.

## Current milestone

M11 adds the 15-case synthetic scenario campaign, fixed-seed property-based sequence tests, twice-reset release evidence, the portfolio case study, system-of-record diagram, and fresh-clone rehearsal. M10 adds synthetic non-production operator role checks, Redis-backed command/ingress/reconciliation rate limits, AES-GCM credential encryption behind a framework-independent cipher interface, durable synthetic remote-delivery receipts, structured allowlisted logs/metrics, safe error correlation IDs, CI dependency/secret scans, and the recovery runbook. M9 adds the tenant-scoped operator read model, named command routes, bounded reconciliation route, and a browser console served at `/`. M8 adds bounded four-pair reconciliation with persisted leases, overlapping watermarks, evidence-backed findings, conservative repair, and synthetic drift fixtures. M6 covers release, warehouse actuals, partial shipment, cancellation compensation, parked-message wake-up, shipment sync, and guarded eligibility propagation. M7 adds tenant-scoped assignment, notes, SKU mapping, short-shipment resolution, dead-letter retry, optimistic concurrency, idempotent command replay, and resolution audit. Billing receives guarded invoice-eligibility events only; no accounting invoice is created. Production vendor integrations remain deferred.

## Local setup

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL and Redis with `docker compose up -d`, or provide equivalent native services.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm db:migrate` and `pnpm db:seed`.
5. Run `pnpm start:api` and inspect `/health/live` and `/health/ready`.

Docker is the portable runtime contract. The development host used for this milestone does not include Docker, so acceptance checks may use native PostgreSQL and Redis services instead.

## Commands

```text
pnpm check
pnpm db:migrate
pnpm db:seed
pnpm db:reset
pnpm test:integration
pnpm test:inbox-ingestion
pnpm test:outbox-dispatcher
pnpm test:mock-adapters
pnpm test:simulator
pnpm test:fulfillment-process
pnpm test:exception-commands
pnpm test:reconciliation
pnpm test:operator
pnpm test:security
pnpm test:scenarios
pnpm test:properties
pnpm test:scenarios:twice
pnpm release:evidence
pnpm release:rehearse
pnpm security:scan
pnpm start:api
```

`pnpm db:reset` is intentionally guarded. It only operates on a database whose name begins with `handoff_control_tower_demo` or `handoff_control_tower_test`, and only in development/test environments.

## Synthetic mock ingress

The development/test-only mock endpoints are:

- `POST /ingest/commerce/events`
- `POST /ingest/wms/events`
- `POST /ingest/carrier/events`

Each request must include `x-tenant-id` as the trusted mock-ingress tenant context and an `x-handoff-signature` header in the form `sha256=<hex HMAC-SHA256>`. Signatures are computed over the exact raw JSON body using the source-specific synthetic secrets in `.env`. The body is bounded by `INGEST_MAX_BODY_BYTES`, validated before persistence, and never treated as a real vendor contract. Mock ingress is disabled in production and is not a proprietary WMS, carrier, commerce, or accounting integration.

## Synthetic adapter simulator

When `ENABLE_DEMO_SIMULATOR=true` outside production, the API exposes the local simulator control seam:

- `GET /simulator/scenario`
- `PUT /simulator/scenario`
- `POST /simulator/scenario/reset`

The scenario body contains a non-negative `seed`, a `failureRate` from `0` to `1`, a non-negative `delayMs`, and optional operation-specific `failures` and `delays` maps. The operation names are versioned synthetic adapter operations, and the same seed reproduces the same seeded failure decisions. This control seam configures in-memory external-process mocks; it does not write application tables or claim to be a real vendor API.

## Truthful integration boundary

The repository contains no proprietary WMS, carrier, commerce, or accounting connector. Future integrations must implement versioned adapter interfaces using official vendor documentation and authorized credentials. Mock adapters must never be presented as real vendor systems.

## Operator console

In development/test, `pnpm start:api` serves the synthetic operator console at `http://localhost:3000/`.
It reads the tenant-scoped `/api/*` routes, displays loading/empty/error/stale states, and labels
the simulator as `Demo Simulator`. The console does not connect to PostgreSQL directly. Its
headers identify a synthetic demo operator and are rejected by the authentication seam in
production until an external authentication adapter is supplied.

## Scenario campaign and portfolio evidence

The named scenarios in `@handoff/scenarios` exercise the domain seams with synthetic fixtures:
duplicate and out-of-order delivery, quantity-safe partial fulfillment, cancellation
compensation, adapter failure recovery, reconciliation, tracking conflict, and tenant isolation.
Run `pnpm test:scenarios:twice` to execute all 15 fixtures twice from fresh in-memory reset state
with a fixed seed. The output is intentionally labeled synthetic and uses at-least-once delivery
language. The release narrative and evidence live in [`docs/portfolio/CASE_STUDY.md`](docs/portfolio/CASE_STUDY.md),
[`docs/portfolio/SCENARIO_RESULTS.md`](docs/portfolio/SCENARIO_RESULTS.md), and
[`docs/portfolio/ARCHITECTURE.svg`](docs/portfolio/ARCHITECTURE.svg).
