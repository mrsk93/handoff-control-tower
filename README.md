# Handoff Control Tower

This repository is a production-style portfolio demonstration of the commerce → warehouse → carrier → billing handoff. Vendor integrations are deterministic mocks, and all data is synthetic. The system emits guarded invoice-eligibility events; it does not create accounting invoices.

## Current milestone

M0/M1 establish the NestJS application shells, Drizzle/PostgreSQL persistence seam, Redis configuration, tenant-scoped repositories, checked-in migrations, deterministic seed data, and liveness/readiness checks. Domain orchestration and external adapters are intentionally deferred to later milestones.

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
pnpm start:api
```

`pnpm db:reset` is intentionally guarded. It only operates on a database whose name begins with `handoff_control_tower_demo` or `handoff_control_tower_test`, and only in development/test environments.

## Truthful integration boundary

The repository contains no proprietary WMS, carrier, commerce, or accounting connector. Future integrations must implement versioned adapter interfaces using official vendor documentation and authorized credentials. Mock adapters must never be presented as real vendor systems.
