# Handoff Control Tower

This repository is a production-style portfolio demonstration of the commerce → warehouse → carrier → billing handoff. Vendor integrations are deterministic mocks, and all data is synthetic. The system emits guarded invoice-eligibility events; it does not create accounting invoices.

## Current milestone

M3 adds signed, source-labelled mock ingress on top of the M0/M1 platform and M2 domain primitives. Inbound messages are normalized and persisted to the inbox before any later processing; duplicate and stale submissions are idempotent, and missing order prerequisites are visibly parked. Fulfillment state changes, outbox dispatch, real integrations, and operator UI remain deferred.

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
pnpm start:api
```

`pnpm db:reset` is intentionally guarded. It only operates on a database whose name begins with `handoff_control_tower_demo` or `handoff_control_tower_test`, and only in development/test environments.

## Synthetic mock ingress

The development/test-only mock endpoints are:

- `POST /ingest/commerce/events`
- `POST /ingest/wms/events`
- `POST /ingest/carrier/events`

Each request must include `x-tenant-id` as the trusted mock-ingress tenant context and an `x-handoff-signature` header in the form `sha256=<hex HMAC-SHA256>`. Signatures are computed over the exact raw JSON body using the source-specific synthetic secrets in `.env`. The body is bounded by `INGEST_MAX_BODY_BYTES`, validated before persistence, and never treated as a real vendor contract. Mock ingress is disabled in production and is not a proprietary WMS, carrier, commerce, or accounting integration.

## Truthful integration boundary

The repository contains no proprietary WMS, carrier, commerce, or accounting connector. Future integrations must implement versioned adapter interfaces using official vendor documentation and authorized credentials. Mock adapters must never be presented as real vendor systems.
