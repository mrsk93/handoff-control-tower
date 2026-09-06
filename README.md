# Handoff Control Tower

This repository is a production-style portfolio demonstration of the commerce → warehouse → carrier → billing handoff. Vendor integrations are deterministic mocks, and all data is synthetic. The system emits guarded invoice-eligibility events; it does not create accounting invoices.

## Current milestone

M5 adds versioned external adapter ports and deterministic synthetic commerce, warehouse, carrier, and billing mocks on top of the M0/M1 platform, M2 domain primitives, M3 inbox intake, and M4 outbox dispatcher. The mocks keep state outside PostgreSQL, support tenant-scoped reference lookup and pagination, and expose reproducible failures/delays by scenario seed. Billing receives guarded invoice-eligibility events only; no accounting invoice is created. Fulfillment processing and operator UI remain deferred.

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
