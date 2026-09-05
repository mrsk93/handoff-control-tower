# ADR-001: NestJS application shells with Drizzle persistence

## Status

Accepted for M0/M1.

## Context

The system needs a small HTTP/worker shell, explicit PostgreSQL transactions, and a domain seam that can be tested without framework, ORM, Redis, HTTP, or vendor dependencies. The repository starts empty, so there is no existing framework or ORM compatibility constraint.

## Decision

Use NestJS for application shells and dependency wiring, Drizzle ORM with the `pg` driver for PostgreSQL access, pnpm workspaces, and strict TypeScript. Checked-in SQL migrations are executed by the persistence package; Drizzle table definitions remain the typed query interface.

The domain package exposes plain TypeScript interfaces and functions. NestJS, Drizzle, PostgreSQL, Redis, HTTP, and vendor types may only appear in application or infrastructure packages. External systems will be introduced through adapter interfaces and deterministic implementations.

## Consequences

- NestJS provides a conventional shell for health, operator, and worker entrypoints.
- Drizzle keeps transaction and locking behavior visible instead of hiding it behind a large unit-of-work abstraction.
- The domain seam is deep: callers provide commands and receive domain results without knowing persistence or transport details.
- Migrations and dependency versions are repository-owned and reproducible.

## Rejected alternatives

- Framework-light Node.js was not selected because M0 benefits from NestJS module wiring and the later API/worker split.
- Prisma was not selected because explicit SQL transaction and lock behavior is central to the inbox/outbox design.
